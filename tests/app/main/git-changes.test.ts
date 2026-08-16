import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { captureWorkspaceCheckpoint, collectCheckpointChanges, collectWorkingTreeChanges, NotGitRepositoryError, parseNameStatus, summarizeCheckpointChanges } from "../../../src/main/git-changes";

const execFileAsync = promisify(execFile);
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function repository() {
  const path = await mkdtemp(join(tmpdir(), "cake-git-changes-"));
  directories.push(path);
  await git(path, "init");
  return path;
}

async function git(cwd: string, ...args: string[]) {
  return execFileAsync("git", args, { cwd });
}

async function commit(cwd: string) {
  await git(cwd, "add", "-A");
  await git(cwd, "-c", "user.name=Cake Test", "-c", "user.email=cake@example.test", "commit", "-m", "checkpoint test");
}

describe("Git session checkpoints", () => {
  it("classifies a directory outside Git without exposing Git's command failure", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "cake-non-git-workspace-"));
    directories.push(workspace);

    await expect(captureWorkspaceCheckpoint(workspace, "session")).rejects.toBeInstanceOf(NotGitRepositoryError);
  });

  it("captures cumulative writes, deletions, and renames without changing the real index", async () => {
    const root = await repository();
    await writeFile(join(root, "old.ts"), "export const old = true;\n");
    await writeFile(join(root, "mixed.ts"), "one\n");
    await writeFile(join(root, "deleted.ts"), "remove me\n");
    await commit(root);
    const initial = await captureWorkspaceCheckpoint(root, "session");

    await git(root, "mv", "old.ts", "new.ts");
    await writeFile(join(root, "mixed.ts"), "two\n");
    await git(root, "add", "mixed.ts");
    await writeFile(join(root, "mixed.ts"), "three\n");
    await rm(join(root, "deleted.ts"));
    await writeFile(join(root, "fresh.ts"), "export const fresh = true;\n");
    const indexBefore = (await git(root, "diff", "--cached")).stdout;
    const latest = await captureWorkspaceCheckpoint(root, "session");

    expect((await git(root, "diff", "--cached")).stdout).toBe(indexBefore);
    expect(await collectCheckpointChanges(root, initial.tree, latest.tree)).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "new.ts", previousPath: "old.ts", status: "renamed", additions: 0, deletions: 0 }),
      expect.objectContaining({ path: "mixed.ts", status: "modified", additions: 1, deletions: 1, diff: expect.stringContaining("+three") }),
      expect.objectContaining({ path: "deleted.ts", status: "deleted", additions: 0, deletions: 1 }),
      expect.objectContaining({ path: "fresh.ts", status: "added", additions: 1, deletions: 0 })
    ]));
    expect(await summarizeCheckpointChanges(root, initial.tree, latest.tree)).toEqual({ fileCount: 4, additions: 2, deletions: 2 });
  });

  it("reads staged, unstaged, and untracked files without recording a checkpoint ref", async () => {
    const root = await repository();
    await writeFile(join(root, "staged.ts"), "old staged\n");
    await writeFile(join(root, "unstaged.ts"), "old unstaged\n");
    await commit(root);
    await writeFile(join(root, "staged.ts"), "new staged\n");
    await git(root, "add", "staged.ts");
    await writeFile(join(root, "unstaged.ts"), "new unstaged\n");
    await writeFile(join(root, "untracked.ts"), "new untracked\n");
    const indexBefore = (await git(root, "diff", "--cached")).stdout;

    expect(await collectWorkingTreeChanges(root)).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "staged.ts", status: "modified", diff: expect.stringContaining("+new staged") }),
      expect.objectContaining({ path: "unstaged.ts", status: "modified", diff: expect.stringContaining("+new unstaged") }),
      expect.objectContaining({ path: "untracked.ts", status: "added", diff: expect.stringContaining("+new untracked") })
    ]));
    expect((await git(root, "diff", "--cached")).stdout).toBe(indexBefore);
    expect((await git(root, "show-ref")).stdout).not.toContain("refs/cake/checkpoints");
  });

  it("keeps checkpoint changes visible after commits and branch deletion", async () => {
    const root = await repository();
    await writeFile(join(root, "app.ts"), "export const value = 1;\n");
    await commit(root);
    const initial = await captureWorkspaceCheckpoint(root, "session");
    await writeFile(join(root, "app.ts"), "export const value = 2;\n");
    const latest = await captureWorkspaceCheckpoint(root, "session");
    await commit(root);

    expect(await collectCheckpointChanges(root, initial.tree, latest.tree)).toEqual([
      expect.objectContaining({ path: "app.ts", status: "modified", additions: 1, deletions: 1 })
    ]);
    expect((await git(root, "show-ref", latest.ref)).stdout).toContain(latest.tree);
  });

  it("captures only a subdirectory workspace while retaining the repository outside it", async () => {
    const root = await repository();
    const workspace = join(root, "packages", "app");
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, "index.ts"), "export const value = 1;\n");
    await writeFile(join(root, "outside.ts"), "outside one\n");
    await commit(root);
    const initial = await captureWorkspaceCheckpoint(workspace, "session");
    await writeFile(join(workspace, "index.ts"), "export const value = 2;\n");
    await writeFile(join(root, "outside.ts"), "outside two\n");
    const latest = await captureWorkspaceCheckpoint(workspace, "session");

    expect(await collectCheckpointChanges(workspace, initial.tree, latest.tree)).toEqual([
      expect.objectContaining({ path: "index.ts", status: "modified" })
    ]);
    expect(await readFile(join(root, "outside.ts"), "utf8")).toBe("outside two\n");
  });

  it("supports unborn repositories", async () => {
    const root = await repository();
    const initial = await captureWorkspaceCheckpoint(root, "session");
    await writeFile(join(root, "index.ts"), "export {};\n");
    const latest = await captureWorkspaceCheckpoint(root, "session");

    expect(await collectCheckpointChanges(root, initial.tree, latest.tree)).toEqual([
      expect.objectContaining({ path: "index.ts", status: "added", additions: 1 })
    ]);
  });
});

describe("parseNameStatus", () => {
  it("parses ordinary and rename records", () => {
    expect(parseNameStatus("M\0src/app.ts\0R100\0old name.ts\0new name.ts\0")).toEqual([
      { path: "src/app.ts", changeCode: "M" },
      { path: "new name.ts", previousPath: "old name.ts", changeCode: "R" }
    ]);
  });
});
