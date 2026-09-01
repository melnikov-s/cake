import { mkdtemp, mkdir, realpath, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveRewordingWorkspace } from "../../../../src/services/projects/rewording-workspace";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "cake-reword-workspace-"));
  const approved = join(root, "approved");
  const other = join(root, "other");
  const approvedAlias = join(root, "approved-alias");
  await Promise.all([mkdir(approved), mkdir(other)]);
  await symlink(approved, approvedAlias);
  return { approved, approvedAlias, other, canonicalApproved: await realpath(approved) };
}

describe("rewording workspace authorization", () => {
  it("accepts only the canonical active user-approved project", async () => {
    const { approved, approvedAlias, other, canonicalApproved } = await fixture();
    const allowedWorkspacePaths = new Set([approved]);

    await expect(
      resolveRewordingWorkspace({
        requestedWorkspace: approvedAlias,
        activeWorkspace: approved,
        allowedWorkspacePaths,
      }),
    ).resolves.toBe(canonicalApproved);
    await expect(
      resolveRewordingWorkspace({
        requestedWorkspace: other,
        activeWorkspace: approved,
        allowedWorkspacePaths,
      }),
    ).resolves.toBeUndefined();
    await expect(
      resolveRewordingWorkspace({
        requestedWorkspace: approved,
        activeWorkspace: other,
        allowedWorkspacePaths,
      }),
    ).resolves.toBeUndefined();
    await expect(
      resolveRewordingWorkspace({
        requestedWorkspace: "relative/project",
        activeWorkspace: approved,
        allowedWorkspacePaths,
      }),
    ).resolves.toBeUndefined();
  });
});
