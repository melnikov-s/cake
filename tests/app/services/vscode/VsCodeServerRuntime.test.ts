import { EventEmitter } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { PassThrough } from "node:stream";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { parse as parseJsonc } from "jsonc-parser";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  VsCodeServerRuntime,
  type CompanionManifest,
  type ServerInstance,
} from "../../../../src/services/vscode/VsCodeServerRuntime";

const companionManifest: CompanionManifest = {
  name: "cake-companion",
  displayName: "Cake Companion",
  description: "Test companion",
  version: "0.0.0",
  publisher: "cake",
  private: true,
  license: "UNLICENSED",
  engines: { vscode: "*" },
  main: "./extension.js",
  activationEvents: [],
  contributes: { commands: [] },
};

type RuntimeProps = ConstructorParameters<typeof VsCodeServerRuntime>[0];

interface RuntimeOverrides {
  root: string;
  companionMain?: string;
  companionThemes?: RuntimeProps["companionThemes"];
  preferredTheme?: RuntimeProps["preferredTheme"];
  broadcast?: RuntimeProps["broadcast"];
  pollUntil?: RuntimeProps["pollUntil"];
  spawnServer?: RuntimeProps["spawnServer"];
}

function createRuntime({
  root,
  companionMain = "/unused/companion.js",
  companionThemes = [],
  preferredTheme = async () => "dark" as const,
  broadcast = () => undefined,
  pollUntil = async (_key, check, _interval, _timeout, failure) => {
    const value = check();
    if (value !== undefined) return value;
    throw new Error(failure);
  },
  spawnServer,
}: RuntimeOverrides) {
  const runtime: VsCodeServerRuntime = new VsCodeServerRuntime({
    root,
    ...(spawnServer ? { spawnServer } : null),
    companionManifest,
    companionMain,
    companionThemes,
    customPath: () => undefined,
    preferredTheme,
    broadcast,
    stateChanged: () => undefined,
    scheduleIdleEviction: () => undefined,
    cancelIdleEviction: () => undefined,
    invalidateServer: () => undefined,
    evictServer: async () => undefined,
    pollUntil,
    acquireServer: (workspacePath, binary): Promise<ServerInstance> =>
      runtime.startServer(workspacePath, binary),
  });
  return runtime;
}

describe("VsCodeServerRuntime startup", () => {
  let root: string | undefined;
  let runtime: VsCodeServerRuntime | undefined;

  afterEach(async () => {
    runtime?.disposeAll();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("retains bounds reported before the native view exists", () => {
    runtime = createRuntime({ root: "/unused" });
    const view = {
      setVisible: vi.fn(),
      setBounds: vi.fn(),
      webContents: {
        isDestroyed: vi.fn(() => false),
        isLoadingMainFrame: vi.fn(() => true),
      },
    };

    runtime.updateBounds(17, {
      visible: true,
      x: 10.4,
      y: 62.2,
      width: 901.8,
      height: 700.6,
      projectSidebarWidth: 292,
    });
    runtime["applyRequestedBounds"](17, view as never);

    expect(view.setVisible).toHaveBeenCalledWith(true);
    expect(view.setBounds).toHaveBeenCalledWith({ x: 10, y: 62, width: 902, height: 701 });
  });

  it("suppresses the native view while a fullscreen Cake surface is open", () => {
    runtime = createRuntime({ root: "/unused" });
    const view = {
      setVisible: vi.fn(),
      setBounds: vi.fn(),
      webContents: { executeJavaScript: vi.fn(async () => undefined) },
    };
    runtime["views"].set(17, { workspacePath: "/real/project", view: view as never });
    runtime.updateBounds(17, {
      visible: true,
      x: 320,
      y: 0,
      width: 900,
      height: 700,
      projectSidebarWidth: 320,
    });

    runtime.setFullscreenSurfaceOpen(17, true);
    expect(view.setVisible).toHaveBeenLastCalledWith(false);

    runtime.updateBounds(17, {
      visible: true,
      x: 300,
      y: 0,
      width: 920,
      height: 700,
      projectSidebarWidth: 300,
    });
    expect(view.setVisible).toHaveBeenLastCalledWith(false);

    runtime.setFullscreenSurfaceOpen(17, false);
    expect(view.setVisible).toHaveBeenLastCalledWith(true);
    expect(view.setBounds).toHaveBeenLastCalledWith({ x: 300, y: 0, width: 920, height: 700 });
  });

  it("routes a native close back to the agent while the editor view is visible", () => {
    const broadcast = vi.fn();
    runtime = createRuntime({ root: "/unused", broadcast });
    const view = {
      setVisible: vi.fn(),
      setBounds: vi.fn(),
      webContents: { executeJavaScript: vi.fn(async () => undefined) },
    };
    runtime["views"].set(17, { workspacePath: "/real/project", view: view as never });
    runtime["presentedWorkspacePaths"].set("/real/project", "/linked/project");
    runtime.updateBounds(17, {
      visible: true,
      x: 0,
      y: 0,
      width: 900,
      height: 700,
      projectSidebarWidth: 292,
    });

    expect(runtime.backToAgentForWindow(17)).toBe(true);
    expect(view.setVisible).toHaveBeenLastCalledWith(false);
    expect(broadcast).toHaveBeenCalledWith({
      type: "embedded-editor-back-to-agent",
      workspacePath: "/linked/project",
    });
    expect(runtime.backToAgentForWindow(17)).toBe(false);
  });

  it("kills a spawned server when startup is canceled", async () => {
    root = await mkdtemp(join(tmpdir(), "cake-vscode-runtime-"));
    const companionMain = join(root, "companion.js");
    await writeFile(companionMain, "module.exports = {};\n");
    let spawned!: () => void;
    const didSpawn = new Promise<void>((resolvePromise) => {
      spawned = resolvePromise;
    });
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      kill: ReturnType<typeof vi.fn>;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = vi.fn(() => true);
    const spawnServer = vi.fn(() => {
      spawned();
      return child;
    });
    runtime = createRuntime({ root, companionMain, spawnServer: spawnServer as never });
    const controller = new AbortController();

    const starting = runtime.startServer(root, "/fake/code-server", controller.signal);
    await didSpawn;
    controller.abort();

    await expect(starting).rejects.toBeDefined();
    expect(child.kill).toHaveBeenCalled();
    expect(runtime["servers"].size).toBe(0);
  });

  it("does not register a server that becomes ready after runtime disposal", async () => {
    root = await mkdtemp(join(tmpdir(), "cake-vscode-runtime-"));
    const companionMain = join(root, "companion.js");
    await writeFile(companionMain, "module.exports = {};\n");
    let spawned!: () => void;
    const didSpawn = new Promise<void>((resolvePromise) => {
      spawned = resolvePromise;
    });
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      kill: ReturnType<typeof vi.fn>;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = vi.fn(() => true);
    runtime = createRuntime({
      root,
      companionMain,
      spawnServer: vi.fn(() => {
        spawned();
        return child;
      }) as never,
    });

    const starting = runtime.startServer(root, "/fake/code-server");
    await didSpawn;
    runtime.disposeAll();
    child.stdout.write("HTTP server listening on http://127.0.0.1\n");

    await expect(starting).rejects.toThrow("disposed");
    expect(child.kill).toHaveBeenCalled();
    expect(runtime["servers"].size).toBe(0);
  });

  it("threads cancellation through visibility polling", async () => {
    root = await mkdtemp(join(tmpdir(), "cake-vscode-runtime-"));
    let pollingStarted!: () => void;
    const didStartPolling = new Promise<void>((resolvePromise) => {
      pollingStarted = resolvePromise;
    });
    let pollingStopped = false;
    runtime = createRuntime({
      root,
      pollUntil: (_key, _check, _interval, _timeout, _failure, signal) =>
        new Promise((_resolve, reject) => {
          pollingStarted();
          signal?.addEventListener(
            "abort",
            () => {
              pollingStopped = true;
              reject(signal.reason);
            },
            { once: true },
          );
        }),
    });
    const controller = new AbortController();

    const visible = runtime.waitUntilVisible(root, controller.signal);
    await didStartPolling;
    controller.abort();

    await expect(visible).rejects.toBeDefined();
    expect(pollingStopped).toBe(true);
  });

  it("destroys an in-flight companion request when canceled", async () => {
    root = await mkdtemp(join(tmpdir(), "cake-vscode-runtime-"));
    let requestStarted!: () => void;
    const didStartRequest = new Promise<void>((resolvePromise) => {
      requestStarted = resolvePromise;
    });
    let requestAborted!: () => void;
    const didAbortRequest = new Promise<void>((resolvePromise) => {
      requestAborted = resolvePromise;
    });
    const server = createServer((request) => {
      requestStarted();
      request.once("close", requestAborted);
    });
    await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
    const companionPort = (server.address() as AddressInfo).port;
    runtime = createRuntime({ root });
    const resolvedRoot = await realpath(root);
    runtime["servers"].set(resolvedRoot, {
      workspacePath: resolvedRoot,
      child: { kill: () => undefined, removeAllListeners: () => undefined } as never,
      port: 1,
      token: "token",
      flavor: "codeserver",
      binary: "/fake/code-server",
      lastUsedAt: 0,
      viewers: 1,
    });
    runtime["companionPorts"].set(resolvedRoot, companionPort);
    const controller = new AbortController();

    const request = runtime.runScript(root, "return input", null, controller.signal);
    await didStartRequest;
    controller.abort();

    await expect(request).rejects.toBeDefined();
    await didAbortRequest;
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
  });

  it("observes the listening message before pausing output", async () => {
    root = await mkdtemp(join(tmpdir(), "cake-vscode-runtime-"));
    const companionMain = join(root, "companion.js");
    const binary = join(root, "fake-code-server");
    await writeFile(companionMain, "module.exports = {};\n");
    await writeFile(
      binary,
      '#!/bin/sh\necho "HTTP server listening on http://127.0.0.1"\nsleep 30\n',
    );
    await chmod(binary, 0o755);

    runtime = createRuntime({ root, companionMain });
    await expect(runtime["serverFor"](root, binary)).resolves.toBeDefined();
    expect(runtime.status).toBe("ready");
  });

  it("relays VS Code title-bar and active-context events to the renderer", () => {
    const broadcast = vi.fn();
    runtime = createRuntime({ root: "/unused", broadcast });

    runtime["handleBridgeMessage"](
      Buffer.from(JSON.stringify({ type: "toggle-chat-sidebar", workspace: "/project" })),
    );
    expect(broadcast).toHaveBeenCalledWith({
      type: "embedded-editor-toggle-chat",
      workspacePath: "/project",
    });

    runtime["handleBridgeMessage"](
      Buffer.from(JSON.stringify({ type: "toggle-project-sidebar", workspace: "/project" })),
    );
    expect(broadcast).toHaveBeenCalledWith({
      type: "embedded-editor-toggle-sidebar",
      workspacePath: "/project",
    });

    runtime["handleBridgeMessage"](
      Buffer.from(JSON.stringify({ type: "back-to-agent", workspace: "/project" })),
    );
    expect(broadcast).toHaveBeenCalledWith({
      type: "embedded-editor-back-to-agent",
      workspacePath: "/project",
    });

    runtime["handleBridgeMessage"](
      Buffer.from(
        JSON.stringify({
          type: "open-annotation",
          workspace: "/project",
          sessionId: "session-a",
          threadId: "thread-a",
        }),
      ),
    );
    expect(broadcast).toHaveBeenCalledWith({
      type: "embedded-editor-annotation-opened",
      workspacePath: "/project",
      sessionId: "session-a",
      threadId: "thread-a",
    });

    runtime["presentedWorkspacePaths"].set("/real/project", "/linked/project");
    runtime["handleBridgeMessage"](
      Buffer.from(JSON.stringify({ type: "selection-cleared", workspace: "/real/project" })),
    );
    expect(broadcast).toHaveBeenCalledWith({
      type: "embedded-editor-selection-cleared",
      workspacePath: "/linked/project",
    });

    runtime["handleBridgeMessage"](
      Buffer.from(
        JSON.stringify({
          type: "selection",
          workspace: "/real/project",
          path: "src/main.ts",
          startLine: 4,
          endLine: 8,
        }),
      ),
    );
    expect(broadcast).toHaveBeenCalledWith({
      type: "embedded-editor-selection",
      workspacePath: "/linked/project",
      path: "src/main.ts",
      startLine: 4,
      endLine: 8,
    });
  });

  it("relays explicit selection actions with their source and note to the renderer", () => {
    const broadcast = vi.fn();
    runtime = createRuntime({ root: "/unused", broadcast });
    runtime["presentedWorkspacePaths"].set("/real/project", "/linked/project");
    const selection = {
      workspace: "/real/project",
      path: "src/main.ts",
      startLine: 4,
      startColumn: 2,
      endLine: 5,
      endColumn: 8,
      selectedText: "const answer =\n  calculate();",
      contextBefore: "function run() {",
      contextAfter: "}",
    };

    runtime["handleBridgeMessage"](
      Buffer.from(JSON.stringify({ type: "add-annotation", ...selection, comment: "Why?" })),
    );
    expect(broadcast).toHaveBeenLastCalledWith({
      type: "embedded-editor-annotation-requested",
      workspacePath: "/linked/project",
      path: "src/main.ts",
      startLine: 4,
      startColumn: 2,
      endLine: 5,
      endColumn: 8,
      selectedText: "const answer =\n  calculate();",
      contextBefore: "function run() {",
      contextAfter: "}",
      comment: "Why?",
    });

    runtime["handleBridgeMessage"](
      Buffer.from(JSON.stringify({ type: "add-annotation", ...selection })),
    );
    expect(broadcast).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ comment: expect.anything() }),
    );

    runtime["handleBridgeMessage"](
      Buffer.from(JSON.stringify({ type: "ask-in-side-chat", ...selection })),
    );
    expect(broadcast).toHaveBeenLastCalledWith({
      type: "embedded-editor-side-chat-requested",
      workspacePath: "/linked/project",
      path: "src/main.ts",
      startLine: 4,
      startColumn: 2,
      endLine: 5,
      endColumn: 8,
      selectedText: "const answer =\n  calculate();",
      contextBefore: "function run() {",
      contextAfter: "}",
    });

    // An empty selection is never an explicit action; the schema rejects it.
    broadcast.mockClear();
    runtime["handleBridgeMessage"](
      Buffer.from(JSON.stringify({ type: "ask-in-side-chat", ...selection, selectedText: "" })),
    );
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("applies Cake's theme on every start while preserving other user settings", async () => {
    root = await mkdtemp(join(tmpdir(), "cake-vscode-runtime-"));
    runtime = createRuntime({ root });
    const settingsPath = join(root, "profile", "User", "settings.json");

    await runtime["ensureEditorPreferences"](join(root, "profile"));
    expect(JSON.parse(await readFile(settingsPath, "utf8"))).toEqual({
      "security.workspace.trust.enabled": false,
      "workbench.colorTheme": "Cake Dark",
      "workbench.startupEditor": "none",
      "workbench.secondarySideBar.defaultVisibility": "hidden",
      "chat.disableAIFeatures": true,
      "extensions.ignoreRecommendations": true,
    });

    await writeFile(
      settingsPath,
      `{
  // Keep this comment; Cake still canonicalizes the keys around it.
  "security.workspace.trust.enabled": true,
  "workbench.colorTheme": "Solarized Light",
  "workbench.secondarySideBar.defaultVisibility": "visible",
  "chat.disableAIFeatures": false,
  "github.copilot.enable": { "*": true },
  "extensions.autoUpdate": true,
}
`,
    );
    await runtime["ensureEditorPreferences"](join(root, "profile"));
    const updatedRaw = await readFile(settingsPath, "utf8");
    expect(updatedRaw).toContain("Keep this comment; Cake still canonicalizes the keys around it.");
    expect(parseJsonc(updatedRaw)).toEqual({
      "security.workspace.trust.enabled": false,
      "workbench.colorTheme": "Cake Dark",
      "workbench.startupEditor": "none",
      "workbench.secondarySideBar.defaultVisibility": "hidden",
      "chat.disableAIFeatures": true,
      "github.copilot.enable": { "*": true },
      "extensions.autoUpdate": true,
      "extensions.ignoreRecommendations": true,
    });

    const lightRuntime = createRuntime({ root, preferredTheme: async () => "light" });
    runtime = lightRuntime;
    await lightRuntime["ensureEditorPreferences"](join(root, "profile-light"));
    expect(
      JSON.parse(await readFile(join(root, "profile-light", "User", "settings.json"), "utf8"))[
        "workbench.colorTheme"
      ],
    ).toBe("Cake Light");
  });

  it("writes the companion's contributed theme files into the extension directory", async () => {
    root = await mkdtemp(join(tmpdir(), "cake-vscode-runtime-"));
    const companionMain = join(root, "companion.js");
    await writeFile(companionMain, "module.exports = {};\n");
    runtime = createRuntime({
      root,
      companionMain,
      companionThemes: [
        { path: "./themes/cake-light-color-theme.json", content: "{}\n" },
        { path: "./themes/cake-dark-color-theme.json", content: "{\n}\n" },
      ],
    });

    const extensionsRoot = await runtime["syncCompanionExtension"]();

    await expect(
      readFile(join(extensionsRoot, "cake-companion", "extension.js"), "utf8"),
    ).resolves.toBe("module.exports = {};\n");
    await expect(
      readFile(
        join(extensionsRoot, "cake-companion", "themes", "cake-light-color-theme.json"),
        "utf8",
      ),
    ).resolves.toBe("{}\n");
    await expect(
      readFile(
        join(extensionsRoot, "cake-companion", "themes", "cake-dark-color-theme.json"),
        "utf8",
      ),
    ).resolves.toBe("{\n}\n");
    expect(stat(join(extensionsRoot, "cake-companion", "package.json"))).toBeDefined();
  });

  it("preserves user extensions while canonicalizing the Cake companion registry entry", async () => {
    root = await mkdtemp(join(tmpdir(), "cake-vscode-runtime-"));
    const companionMain = join(root, "companion.js");
    await writeFile(companionMain, "module.exports = {};\n");
    runtime = createRuntime({ root, companionMain });
    const extensionsRoot = join(root, "extensions");
    await mkdir(join(extensionsRoot, "github.copilot"), { recursive: true });
    await mkdir(join(extensionsRoot, "esbenp.prettier-vscode"), { recursive: true });
    await mkdir(join(extensionsRoot, "cake-companion"), { recursive: true });
    await writeFile(
      join(extensionsRoot, "extensions.json"),
      JSON.stringify([
        {
          identifier: { id: "GitHub.copilot" },
          version: "1.0.0",
          location: { scheme: "file", path: join(extensionsRoot, "github.copilot") },
          relativeLocation: "github.copilot",
        },
        {
          identifier: { id: "esbenp.prettier-vscode" },
          version: "10.0.0",
          location: { scheme: "file", path: join(extensionsRoot, "esbenp.prettier-vscode") },
          relativeLocation: "esbenp.prettier-vscode",
        },
        {
          identifier: { id: "cake.cake-companion" },
          version: "0.0.0",
          location: { scheme: "file", path: "/stale/cake-companion" },
          relativeLocation: "cake-companion",
        },
      ]),
    );

    await runtime["syncCompanionExtension"]();

    await expect(stat(join(extensionsRoot, "github.copilot"))).resolves.toBeDefined();
    await expect(stat(join(extensionsRoot, "esbenp.prettier-vscode"))).resolves.toBeDefined();
    const registry = JSON.parse(await readFile(join(extensionsRoot, "extensions.json"), "utf8"));
    expect(registry.map((entry: { identifier: { id: string } }) => entry.identifier.id)).toEqual([
      "GitHub.copilot",
      "esbenp.prettier-vscode",
      "cake.cake-companion",
    ]);
  });

  it("sends curated editor actions to the companion and returns their result", async () => {
    root = await mkdtemp(join(tmpdir(), "cake-vscode-runtime-"));
    const received: unknown[] = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        received.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        response
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ action: "layout.set", layout: "two-columns" }));
      });
    });
    await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
    const companionPort = (server.address() as AddressInfo).port;
    const resolvedRoot = await realpath(root);

    try {
      runtime = createRuntime({ root });
      runtime["servers"].set(resolvedRoot, {
        workspacePath: resolvedRoot,
        child: { kill: () => undefined, removeAllListeners: () => undefined } as never,
        port: 1,
        token: "token",
        flavor: "codeserver",
        binary: "/fake/code-server",
        lastUsedAt: 0,
        viewers: 1,
      });
      runtime["companionPorts"].set(resolvedRoot, companionPort);

      await expect(
        runtime.performEditorAction(root, { type: "layout.set", layout: "two-columns" }),
      ).resolves.toEqual({ action: "layout.set", layout: "two-columns" });
      expect(received).toEqual([
        { type: "editor-action", action: { type: "layout.set", layout: "two-columns" } },
      ]);
    } finally {
      await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    }
  });

  it("pushes the current theme to running companions and skips unchanged preferences", async () => {
    root = await mkdtemp(join(tmpdir(), "cake-vscode-runtime-"));
    const received: unknown[] = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        received.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        response.writeHead(204).end();
      });
    });
    await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
    const companionPort = (server.address() as AddressInfo).port;

    try {
      let preference: "light" | "dark" = "dark";
      runtime = createRuntime({ root, preferredTheme: async () => preference });
      runtime["servers"].set("/project", {
        workspacePath: "/project",
        child: { kill: () => undefined, removeAllListeners: () => undefined } as never,
        port: 1,
        token: "token",
        flavor: "codeserver",
        binary: "/fake/code-server",
        lastUsedAt: 0,
        viewers: 1,
      });
      runtime["companionPorts"].set("/project", companionPort);

      await runtime.updateTheme();
      await runtime.updateTheme();
      expect(received).toEqual([{ type: "set-theme", theme: "dark" }]);

      preference = "light";
      await runtime.updateTheme();
      expect(received).toEqual([
        { type: "set-theme", theme: "dark" },
        { type: "set-theme", theme: "light" },
      ]);
    } finally {
      await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    }
  });
});
