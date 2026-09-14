import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  resolveEditorTarget,
  resolveSourceTarget,
} from "../../../../src/services/vscode/source-path-policy";

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

  it("resolves an absolute editor file without changing the Working Directory", async () => {
    const { workspace } = await workspaceFixture();
    const externalRoot = await mkdtemp(join(tmpdir(), "cake-external-file-"));
    roots.push(externalRoot);
    const target = join(externalRoot, "server.log");
    await writeFile(target, "ready\n");

    await expect(
      resolveEditorTarget(workspace, { kind: "absolute-file", path: target }),
    ).resolves.toEqual({
      workspace: await realpath(workspace),
      target: await realpath(target),
      location: { kind: "absolute-file", path: await realpath(target) },
    });
  });

  it("normalizes a Working Directory editor file to a relative path", async () => {
    const { workspace, target } = await workspaceFixture();

    await expect(
      resolveEditorTarget(workspace, { kind: "working-directory", path: "src/main.ts" }),
    ).resolves.toEqual({
      workspace: await realpath(workspace),
      target: await realpath(target),
      location: { kind: "working-directory", path: "src/main.ts" },
    });
  });

  it("rejects a relative path labeled as an absolute editor file", async () => {
    const { workspace } = await workspaceFixture();

    await expect(
      resolveEditorTarget(workspace, { kind: "absolute-file", path: "src/main.ts" }),
    ).rejects.toThrow("absolute editor file path");
  });

  it("rejects a vscode-remote editor URI outside the workspace", async () => {
    const { workspace } = await workspaceFixture();

    await expect(
      resolveSourceTarget(workspace, "vscode-remote://127.0.0.1:62654/etc/passwd"),
    ).rejects.toThrow("outside the selected project");
  });
});
