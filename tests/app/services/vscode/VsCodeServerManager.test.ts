import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { parse as parseJsonc } from "jsonc-parser";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  VsCodeServerManager,
  type CompanionManifest,
} from "../../../../src/services/vscode/VsCodeServerManager";

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

type ManagerProps = ConstructorParameters<typeof VsCodeServerManager>[0];

interface ManagerOverrides {
  root: string;
  companionMain?: string;
  companionThemes?: ManagerProps["companionThemes"];
  preferredTheme?: ManagerProps["preferredTheme"];
  broadcast?: ManagerProps["broadcast"];
}

function createManager({
  root,
  companionMain = "/unused/companion.js",
  companionThemes = [],
  preferredTheme = async () => "dark" as const,
  broadcast = () => undefined,
}: ManagerOverrides) {
  return new VsCodeServerManager({
    root,
    companionManifest,
    companionMain,
    companionThemes,
    customPath: () => undefined,
    preferredTheme,
    broadcast,
    stateChanged: () => undefined,
  });
}

describe("VsCodeServerManager startup", () => {
  let root: string | undefined;
  let manager: VsCodeServerManager | undefined;

  afterEach(async () => {
    manager?.disposeAll();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("retains bounds reported before the native view exists", () => {
    manager = createManager({ root: "/unused" });
    const view = {
      setVisible: vi.fn(),
      setBounds: vi.fn(),
      webContents: {
        isDestroyed: vi.fn(() => false),
        isLoadingMainFrame: vi.fn(() => true),
      },
    };

    manager.updateBounds(17, {
      visible: true,
      x: 10.4,
      y: 62.2,
      width: 901.8,
      height: 700.6,
      projectSidebarWidth: 292,
    });
    manager["applyRequestedBounds"](17, view as never);

    expect(view.setVisible).toHaveBeenCalledWith(true);
    expect(view.setBounds).toHaveBeenCalledWith({ x: 10, y: 62, width: 902, height: 701 });
  });

  it("routes a native close back to the agent while the editor view is visible", () => {
    const broadcast = vi.fn();
    manager = createManager({ root: "/unused", broadcast });
    const view = {
      setVisible: vi.fn(),
      setBounds: vi.fn(),
      webContents: { executeJavaScript: vi.fn(async () => undefined) },
    };
    manager["views"].set(17, { workspacePath: "/real/project", view: view as never });
    manager["presentedWorkspacePaths"].set("/real/project", "/linked/project");
    manager.updateBounds(17, {
      visible: true,
      x: 0,
      y: 0,
      width: 900,
      height: 700,
      projectSidebarWidth: 292,
    });

    expect(manager.backToAgentForWindow(17)).toBe(true);
    expect(view.setVisible).toHaveBeenLastCalledWith(false);
    expect(broadcast).toHaveBeenCalledWith({
      type: "embedded-editor-back-to-agent",
      workspacePath: "/linked/project",
    });
    expect(manager.backToAgentForWindow(17)).toBe(false);
  });

  it("observes the listening message before pausing output and clears startup bookkeeping", async () => {
    root = await mkdtemp(join(tmpdir(), "cake-vscode-manager-"));
    const companionMain = join(root, "companion.js");
    const binary = join(root, "fake-code-server");
    await writeFile(companionMain, "module.exports = {};\n");
    await writeFile(
      binary,
      '#!/bin/sh\necho "HTTP server listening on http://127.0.0.1"\nsleep 30\n',
    );
    await chmod(binary, 0o755);

    manager = createManager({ root, companionMain });
    await expect(manager["serverFor"](root, binary)).resolves.toBeDefined();
    expect(manager["starting"].size).toBe(0);
    expect(manager.status).toBe("ready");
  });

  it("relays VS Code title-bar and active-context events to the renderer", () => {
    const broadcast = vi.fn();
    manager = createManager({ root: "/unused", broadcast });

    manager["handleBridgeMessage"](
      Buffer.from(JSON.stringify({ type: "toggle-chat-sidebar", workspace: "/project" })),
    );
    expect(broadcast).toHaveBeenCalledWith({
      type: "embedded-editor-toggle-chat",
      workspacePath: "/project",
    });

    manager["handleBridgeMessage"](
      Buffer.from(JSON.stringify({ type: "toggle-project-sidebar", workspace: "/project" })),
    );
    expect(broadcast).toHaveBeenCalledWith({
      type: "embedded-editor-toggle-sidebar",
      workspacePath: "/project",
    });

    manager["handleBridgeMessage"](
      Buffer.from(JSON.stringify({ type: "back-to-agent", workspace: "/project" })),
    );
    expect(broadcast).toHaveBeenCalledWith({
      type: "embedded-editor-back-to-agent",
      workspacePath: "/project",
    });

    manager["handleBridgeMessage"](
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

    manager["presentedWorkspacePaths"].set("/real/project", "/linked/project");
    manager["handleBridgeMessage"](
      Buffer.from(JSON.stringify({ type: "selection-cleared", workspace: "/real/project" })),
    );
    expect(broadcast).toHaveBeenCalledWith({
      type: "embedded-editor-selection-cleared",
      workspacePath: "/linked/project",
    });

    manager["handleBridgeMessage"](
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

  it("applies Cake's theme on every start while preserving other user settings", async () => {
    root = await mkdtemp(join(tmpdir(), "cake-vscode-manager-"));
    manager = createManager({ root });
    const settingsPath = join(root, "profile", "User", "settings.json");

    await manager["ensureEditorPreferences"](join(root, "profile"));
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
    await manager["ensureEditorPreferences"](join(root, "profile"));
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

    const lightManager = createManager({ root, preferredTheme: async () => "light" });
    manager = lightManager;
    await lightManager["ensureEditorPreferences"](join(root, "profile-light"));
    expect(
      JSON.parse(await readFile(join(root, "profile-light", "User", "settings.json"), "utf8"))[
        "workbench.colorTheme"
      ],
    ).toBe("Cake Light");
  });

  it("writes the companion's contributed theme files into the extension directory", async () => {
    root = await mkdtemp(join(tmpdir(), "cake-vscode-manager-"));
    const companionMain = join(root, "companion.js");
    await writeFile(companionMain, "module.exports = {};\n");
    manager = createManager({
      root,
      companionMain,
      companionThemes: [
        { path: "./themes/cake-light-color-theme.json", content: "{}\n" },
        { path: "./themes/cake-dark-color-theme.json", content: "{\n}\n" },
      ],
    });

    const extensionsRoot = await manager["syncCompanionExtension"]();

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
    root = await mkdtemp(join(tmpdir(), "cake-vscode-manager-"));
    const companionMain = join(root, "companion.js");
    await writeFile(companionMain, "module.exports = {};\n");
    manager = createManager({ root, companionMain });
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

    await manager["syncCompanionExtension"]();

    await expect(stat(join(extensionsRoot, "github.copilot"))).resolves.toBeDefined();
    await expect(stat(join(extensionsRoot, "esbenp.prettier-vscode"))).resolves.toBeDefined();
    const registry = JSON.parse(await readFile(join(extensionsRoot, "extensions.json"), "utf8"));
    expect(registry.map((entry: { identifier: { id: string } }) => entry.identifier.id)).toEqual([
      "GitHub.copilot",
      "esbenp.prettier-vscode",
      "cake.cake-companion",
    ]);
  });

  it("pushes the current theme to running companions and skips unchanged preferences", async () => {
    root = await mkdtemp(join(tmpdir(), "cake-vscode-manager-"));
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
      manager = createManager({ root, preferredTheme: async () => preference });
      manager["servers"].set("/project", {
        workspacePath: "/project",
        child: { kill: () => undefined, removeAllListeners: () => undefined } as never,
        port: 1,
        token: "token",
        flavor: "codeserver",
        lastUsedAt: 0,
        viewers: 1,
      });
      manager["companionPorts"].set("/project", companionPort);

      await manager.updateTheme();
      await manager.updateTheme();
      expect(received).toEqual([{ type: "set-theme", theme: "dark" }]);

      preference = "light";
      await manager.updateTheme();
      expect(received).toEqual([
        { type: "set-theme", theme: "dark" },
        { type: "set-theme", theme: "light" },
      ]);
    } finally {
      await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    }
  });
});
