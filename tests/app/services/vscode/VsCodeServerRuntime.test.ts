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
  companionSource?: string;
  companionThemes?: RuntimeProps["companionThemes"];
  sendTo?: RuntimeProps["sendTo"];
  pollUntil?: RuntimeProps["pollUntil"];
  spawnServer?: RuntimeProps["spawnServer"];
}

function createRuntime({
  root,
  companionSource = "module.exports = {};\n",
  companionThemes = [],
  sendTo = () => undefined,
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
    companionSource,
    companionThemes,
    customPath: () => undefined,
    sendTo,
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

function seedLease(runtime: VsCodeServerRuntime, connectionId: number, workspacePath: string) {
  runtime["leases"].set(connectionId, {
    id: "lease",
    connectionId,
    workspacePath,
    presentedWorkspacePath: workspacePath,
    url: "http://127.0.0.1:4321/",
    revocation: new AbortController(),
    flavor: "codeserver",
    visible: true,
  });
}

describe("VsCodeServerRuntime startup", () => {
  let root: string | undefined;
  let runtime: VsCodeServerRuntime | undefined;

  afterEach(async () => {
    runtime?.disposeAll();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("kills a spawned server when startup is canceled", async () => {
    root = await mkdtemp(join(tmpdir(), "cake-vscode-runtime-"));
    const companionSource = "module.exports = {};\n";
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
    runtime = createRuntime({ root, companionSource, spawnServer: spawnServer as never });
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
    const companionSource = "module.exports = {};\n";
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
      companionSource,
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

  it("returns resolved reveal locations and transports location-only highlight replacements", async () => {
    root = await mkdtemp(join(tmpdir(), "cake-vscode-runtime-"));
    const received: unknown[] = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        received.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        response
          .writeHead(200, { "content-type": "application/json" })
          .end(
            JSON.stringify({ outcome: { view: "file", fallback: "no-changes" }, locations: [] }),
          );
      });
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

    const outcome = await runtime.reveal(root, {
      kind: "working-directory",
      path: "src/app.ts",
      view: "changes",
    });

    expect(outcome).toEqual({ outcome: { view: "file", fallback: "no-changes" }, locations: [] });
    const locations = [
      {
        kind: "working-directory" as const,
        view: "file" as const,
        path: "src/app.ts",
        range: { start: { line: 1 }, end: { line: 3 } },
      },
    ];
    await runtime.updateSelectionHighlights(root, { locations });
    await runtime.updateSelectionHighlights(root, { locations: [] });
    expect(received).toEqual([
      { type: "reveal", kind: "working-directory", path: "src/app.ts", view: "changes" },
      { type: "selection-highlights", locations },
      { type: "selection-highlights", locations: [] },
    ]);
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
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
    const companionSource = "module.exports = {};\n";
    const binary = join(root, "fake-code-server");
    await writeFile(
      binary,
      '#!/bin/sh\necho "HTTP server listening on http://127.0.0.1"\nsleep 30\n',
    );
    await chmod(binary, 0o755);

    runtime = createRuntime({ root, companionSource });
    await expect(runtime["serverFor"](root, binary)).resolves.toBeDefined();
    expect(runtime.status).toBe("ready");
  });

  it("relays VS Code title-bar and active-context events to the renderer", () => {
    const sendTo = vi.fn();
    runtime = createRuntime({ root: "/unused", sendTo });
    seedLease(runtime, 17, "/project");

    runtime["handleBridgeMessage"](
      Buffer.from(JSON.stringify({ type: "toggle-chat-sidebar", workspace: "/project" })),
    );
    expect(sendTo).toHaveBeenCalledWith(17, {
      type: "embedded-editor-toggle-chat",
      workspacePath: "/project",
    });

    runtime["handleBridgeMessage"](
      Buffer.from(JSON.stringify({ type: "toggle-project-sidebar", workspace: "/project" })),
    );
    expect(sendTo).toHaveBeenCalledWith(17, {
      type: "embedded-editor-toggle-sidebar",
      workspacePath: "/project",
    });

    runtime["handleBridgeMessage"](
      Buffer.from(JSON.stringify({ type: "back-to-agent", workspace: "/project" })),
    );
    expect(sendTo).toHaveBeenCalledWith(17, {
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
    expect(sendTo).toHaveBeenCalledWith(17, {
      type: "embedded-editor-annotation-opened",
      workspacePath: "/project",
      sessionId: "session-a",
      threadId: "thread-a",
    });

    seedLease(runtime, 17, "/real/project");
    runtime["presentedWorkspacePaths"].set("/real/project", "/linked/project");
    runtime["handleBridgeMessage"](
      Buffer.from(JSON.stringify({ type: "selection-cleared", workspace: "/real/project" })),
    );
    expect(sendTo).toHaveBeenCalledWith(17, {
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
    expect(sendTo).toHaveBeenCalledWith(17, {
      type: "embedded-editor-selection",
      workspacePath: "/linked/project",
      path: "src/main.ts",
      startLine: 4,
      endLine: 8,
    });
  });

  it("relays explicit selection actions with their source and note to the renderer", () => {
    const sendTo = vi.fn();
    runtime = createRuntime({ root: "/unused", sendTo });
    seedLease(runtime, 17, "/project");
    seedLease(runtime, 17, "/real/project");
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
    expect(sendTo).toHaveBeenLastCalledWith(17, {
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
    expect(sendTo).toHaveBeenLastCalledWith(
      17,
      expect.not.objectContaining({ comment: expect.anything() }),
    );

    runtime["handleBridgeMessage"](
      Buffer.from(JSON.stringify({ type: "ask-in-side-chat", ...selection })),
    );
    expect(sendTo).toHaveBeenLastCalledWith(17, {
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
    sendTo.mockClear();
    runtime["handleBridgeMessage"](
      Buffer.from(JSON.stringify({ type: "ask-in-side-chat", ...selection, selectedText: "" })),
    );
    expect(sendTo).not.toHaveBeenCalled();
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

    const lightRuntime = createRuntime({ root });
    runtime = lightRuntime;
    await lightRuntime["ensureEditorPreferences"](join(root, "profile-light"), "light");
    expect(
      JSON.parse(await readFile(join(root, "profile-light", "User", "settings.json"), "utf8"))[
        "workbench.colorTheme"
      ],
    ).toBe("Cake Light");
  });

  it("writes the companion's contributed theme files into the extension directory", async () => {
    root = await mkdtemp(join(tmpdir(), "cake-vscode-runtime-"));
    const companionSource = "module.exports = {};\n";
    runtime = createRuntime({
      root,
      companionSource,
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
    const companionSource = "module.exports = {};\n";
    runtime = createRuntime({ root, companionSource });
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
      runtime = createRuntime({ root });
      seedLease(runtime, 17, "/project");
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

      await runtime.setTheme(17, "dark");
      await runtime.setTheme(17, "dark");
      expect(received).toEqual([{ type: "set-theme", theme: "dark" }]);

      await runtime.setTheme(17, "light");
      expect(received).toEqual([
        { type: "set-theme", theme: "dark" },
        { type: "set-theme", theme: "light" },
      ]);
    } finally {
      await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    }
  });
});
