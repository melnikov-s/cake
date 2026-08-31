import { mkdtemp, mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createWorkspaceReadTools } from "../../../src/services/pi/runtime/workspace-read-tools";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "cake-reword-tools-"));
  const workspace = join(root, "workspace");
  const outside = join(root, "outside");
  await Promise.all([mkdir(workspace), mkdir(outside)]);
  await Promise.all([
    writeFile(join(workspace, "inside.txt"), "project vocabulary\n"),
    writeFile(join(outside, "secret.txt"), "outside secret\n"),
    symlink(join(outside, "secret.txt"), join(workspace, "escaped-link.txt")),
  ]);
  return { workspace: await realpath(workspace), outside };
}

describe("workspace read tools", () => {
  it("reads project files but rejects absolute, parent, and symlink escapes", async () => {
    const { workspace, outside } = await fixture();
    const tools = createWorkspaceReadTools(workspace);
    const execute = (name: string, params: object) => {
      const tool = tools.find((candidate) => candidate.name === name);
      if (!tool) throw new Error(`Missing ${name} tool`);
      return tool.execute("call", params as never, undefined, undefined, {} as never);
    };

    await expect(execute("read", { path: "inside.txt" })).resolves.toEqual(
      expect.objectContaining({ content: [{ type: "text", text: "project vocabulary\n" }] }),
    );
    await expect(execute("read", { path: join(outside, "secret.txt") })).rejects.toThrow(
      "outside the selected project",
    );
    await expect(execute("read", { path: "../outside/secret.txt" })).rejects.toThrow(
      "outside the selected project",
    );
    await expect(execute("read", { path: "escaped-link.txt" })).rejects.toThrow(
      "outside the selected project",
    );
    await expect(execute("ls", { path: outside })).rejects.toThrow();
    await expect(execute("ls", { path: "escaped-link.txt" })).rejects.toThrow();
  });
});
