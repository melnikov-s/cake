import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import {
  WorkspaceFileExport,
  WorkspaceFileExportLive,
} from "../../../../src/services/filesystem/WorkspaceFileExport";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "cake-draw-export-"));
  roots.push(root);
  const workspace = join(root, "workspace");
  const outside = join(root, "outside");
  await Promise.all([mkdir(join(workspace, "docs"), { recursive: true }), mkdir(outside)]);
  return { workspace, outside };
}

const write = (workingDirectory: string, path: string, content: Uint8Array) =>
  Effect.runPromise(
    Effect.flatMap(WorkspaceFileExport, (service) =>
      service.write({ workingDirectory, path, content }, new AbortController().signal),
    ).pipe(Effect.provide(WorkspaceFileExportLive)),
  );

describe("WorkspaceFileExport", () => {
  it("writes and explicitly replaces a workspace-relative file", async () => {
    const { workspace } = await fixture();
    const target = join(workspace, "docs", "board.svg");
    await writeFile(target, "old");

    const content = new TextEncoder().encode("<svg></svg>");
    const result = await write(workspace, "docs/board.svg", content);

    expect(result).toEqual({ path: "docs/board.svg", bytes: content.byteLength });
    expect(await readFile(target, "utf8")).toBe("<svg></svg>");
  });

  it("rejects traversal, absolute paths, and symlink-parent escapes", async () => {
    const { workspace, outside } = await fixture();
    await symlink(outside, join(workspace, "escaped"));
    const content = new TextEncoder().encode("blocked");

    await expect(write(workspace, "../outside/board.svg", content)).rejects.toThrow(
      "outside the selected project",
    );
    await expect(write(workspace, join(outside, "board.svg"), content)).rejects.toThrow(
      "outside the selected project",
    );
    await expect(write(workspace, "escaped/board.svg", content)).rejects.toThrow(
      "outside the selected project",
    );
  });

  it("rejects writing through an existing symlinked file", async () => {
    const { workspace, outside } = await fixture();
    const external = join(outside, "board.svg");
    await writeFile(external, "external");
    await symlink(external, join(workspace, "docs", "board.svg"));

    await expect(
      write(workspace, "docs/board.svg", new TextEncoder().encode("blocked")),
    ).rejects.toThrow("outside the selected project");
    expect(await readFile(external, "utf8")).toBe("external");
  });
});
