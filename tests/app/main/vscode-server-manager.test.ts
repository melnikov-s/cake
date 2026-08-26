import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    });

    await writeFile(
      settingsPath,
      JSON.stringify({
        "security.workspace.trust.enabled": true,
        "workbench.colorTheme": "Solarized Light",
      }),
    );
    await manager["ensureEditorPreferences"](userDataDir);
    expect(JSON.parse(await readFile(settingsPath, "utf8"))).toEqual({
      "security.workspace.trust.enabled": false,
      "workbench.colorTheme": "Solarized Light",
      "workbench.startupEditor": "none",
    });
  });
});
