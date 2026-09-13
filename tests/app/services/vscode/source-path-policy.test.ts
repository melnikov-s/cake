import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveSourceTarget } from "../../../../src/services/vscode/source-path-policy";

const roots: string[] = [];

async function workspaceFixture() {
  const workspace = await mkdtemp(join(tmpdir(), "cake-source-path-"));
  roots.push(workspace);
  await mkdir(join(workspace, "src"));
  const target = join(workspace, "src", "main.ts");
  await writeFile(target, "export {};\n");
  return { workspace, target };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("VS Code source path policy", () => {
  it("resolves a vscode-remote editor URI to its file inside the workspace", async () => {
    const { workspace, target } = await workspaceFixture();
    const uri = `vscode-remote://127.0.0.1:62654${target}`;

    await expect(resolveSourceTarget(workspace, uri)).resolves.toEqual({
      workspace: await realpath(workspace),
      target: await realpath(target),
    });
  });

  it("rejects a vscode-remote editor URI outside the workspace", async () => {
    const { workspace } = await workspaceFixture();

    await expect(
      resolveSourceTarget(workspace, "vscode-remote://127.0.0.1:62654/etc/passwd"),
    ).rejects.toThrow("outside the selected project");
  });
});
