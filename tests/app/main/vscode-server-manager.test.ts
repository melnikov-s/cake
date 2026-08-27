import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseJsonc } from "jsonc-parser";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  VsCodeServerManager,
  type CompanionManifest,
} from "../../../src/main/vscode-server-manager";

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

describe("VsCodeServerManager startup", () => {
  let root: string | undefined;
  let manager: VsCodeServerManager | undefined;

  afterEach(async () => {
    manager?.disposeAll();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("retains bounds reported before the native view exists", () => {
    manager = new VsCodeServerManager({
      root: "/unused",
      companionManifest,
      companionMain: "/unused/companion.js",
      customPath: () => undefined,
      preferredTheme: async () => "dark",
      broadcast: () => undefined,
    });
    const view = { setVisible: vi.fn(), setBounds: vi.fn() };

    manager.updateBounds(17, {
      visible: true,
      x: 10.4,
      y: 62.2,
      width: 901.8,
      height: 700.6,
    });
    manager["applyRequestedBounds"](17, view as never);

    expect(view.setVisible).toHaveBeenCalledWith(true);
    expect(view.setBounds).toHaveBeenCalledWith({ x: 10, y: 62, width: 902, height: 701 });
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

    manager = new VsCodeServerManager({
      root,
      companionManifest,
      companionMain,
      customPath: () => undefined,
      preferredTheme: async () => "dark",
      broadcast: () => undefined,
    });
    await expect(manager["serverFor"](root, binary)).resolves.toBeDefined();
    expect(manager["starting"].size).toBe(0);
    expect(manager.status).toBe("ready");
  });

  it("relays VS Code title-bar and active-context events to the renderer", () => {
    const broadcast = vi.fn();
    manager = new VsCodeServerManager({
      root: "/unused",
      companionManifest,
      companionMain: "/unused/companion.js",
      customPath: () => undefined,
      preferredTheme: async () => "dark",
      broadcast,
    });

    manager["handleBridgeMessage"](
      Buffer.from(JSON.stringify({ type: "toggle-chat-sidebar", workspace: "/project" })),
    );

    expect(broadcast).toHaveBeenCalledWith({
      type: "embedded-editor-toggle-chat",
      workspacePath: "/project",
    });

    manager["handleBridgeMessage"](
      Buffer.from(JSON.stringify({ type: "back-to-agent", workspace: "/project" })),
    );
    expect(broadcast).toHaveBeenCalledWith({
      type: "embedded-editor-back-to-agent",
      workspacePath: "/project",
    });

    manager["presentedWorkspacePaths"].set("/real/project", "/linked/project");
    manager["handleBridgeMessage"](
      Buffer.from(JSON.stringify({ type: "activity-cleared", workspace: "/real/project" })),
    );
    expect(broadcast).toHaveBeenCalledWith({
      type: "embedded-editor-context-cleared",
      workspacePath: "/linked/project",
    });
  });

  it("disables duplicate workspace trust and seeds a theme without replacing theme choices", async () => {
    root = await mkdtemp(join(tmpdir(), "cake-vscode-manager-"));
    manager = new VsCodeServerManager({
      root,
      companionManifest,
      companionMain: "/unused/companion.js",
      customPath: () => undefined,
      preferredTheme: async () => "dark",
      broadcast: () => undefined,
    });
    const userDataDir = join(root, "profile");

    await manager["ensureEditorPreferences"](userDataDir);
    const settingsPath = join(userDataDir, "User", "settings.json");
    expect(JSON.parse(await readFile(settingsPath, "utf8"))).toEqual({
      "security.workspace.trust.enabled": false,
      "workbench.colorTheme": "Default Dark Modern",
      "workbench.startupEditor": "none",
      "github.copilot.enable": { "*": false },
      "extensions.autoUpdate": false,
      "extensions.autoCheckUpdates": false,
      "extensions.ignoreRecommendations": true,
    });

    await writeFile(
      settingsPath,
      `{
  // Preserve the user's chosen theme and comments.
  "security.workspace.trust.enabled": true,
  "workbench.colorTheme": "Solarized Light",
  "github.copilot.enable": { "*": true },
  "extensions.autoUpdate": true,
}
`,
    );
    await manager["ensureEditorPreferences"](userDataDir);
    const updatedRaw = await readFile(settingsPath, "utf8");
    expect(updatedRaw).toContain("Preserve the user's chosen theme and comments.");
    expect(parseJsonc(updatedRaw)).toEqual({
      "security.workspace.trust.enabled": false,
      "workbench.colorTheme": "Solarized Light",
      "workbench.startupEditor": "none",
      "github.copilot.enable": { "*": false },
      "extensions.autoUpdate": false,
      "extensions.autoCheckUpdates": false,
      "extensions.ignoreRecommendations": true,
    });
  });

  it("prunes Copilot while preserving unrelated extensions and registry entries", async () => {
    root = await mkdtemp(join(tmpdir(), "cake-vscode-manager-"));
    const companionMain = join(root, "companion.js");
    await writeFile(companionMain, "module.exports = {};\n");
    manager = new VsCodeServerManager({
      root,
      companionManifest,
      companionMain,
      customPath: () => undefined,
      preferredTheme: async () => "dark",
      broadcast: () => undefined,
    });
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

    await expect(stat(join(extensionsRoot, "github.copilot"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(stat(join(extensionsRoot, "esbenp.prettier-vscode"))).resolves.toBeDefined();
    const registry = JSON.parse(await readFile(join(extensionsRoot, "extensions.json"), "utf8"));
    expect(registry.map((entry: { identifier: { id: string } }) => entry.identifier.id)).toEqual([
      "esbenp.prettier-vscode",
      "cake.cake-companion",
    ]);
  });
});
