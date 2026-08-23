import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
      broadcast: () => undefined,
    });
    await expect(manager["serverFor"](root, binary)).resolves.toBeDefined();
    expect(manager["starting"].size).toBe(0);
    expect(manager.status).toBe("ready");
  });
});
