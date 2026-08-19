import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { collectWorkingTreeChanges, NotGitRepositoryError, parseNameStatus } from "../../../src/main/git-changes";

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
  await git(cwd, "-c", "user.name=Cake Test", "-c", "user.email=cake@example.test", "commit", "-m", "fixture");
}

describe("Git working-tree changes", () => {
  it("classifies a directory outside Git without exposing Git's command failure", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "cake-non-git-workspace-"));
    directories.push(workspace);
    await expect(collectWorkingTreeChanges(workspace)).rejects.toBeInstanceOf(NotGitRepositoryError);
  });

  it("reads staged, unstaged, untracked, deleted, and renamed files without changing the index or creating refs", async () => {
    const root = await repository();
    await writeFile(join(root, "staged.ts"), "old staged\n");
    await writeFile(join(root, "unstaged.ts"), "old unstaged\n");
    await writeFile(join(root, "old.ts"), "rename me\n");
    await writeFile(join(root, "deleted.ts"), "delete me\n");
    await commit(root);
    await writeFile(join(root, "staged.ts"), "new staged\n");
    await git(root, "add", "staged.ts");
    await writeFile(join(root, "unstaged.ts"), "new unstaged\n");
    await git(root, "mv", "old.ts", "new.ts");
    await rm(join(root, "deleted.ts"));
    await writeFile(join(root, "untracked.ts"), "new untracked\n");
    const indexBefore = (await git(root, "diff", "--cached")).stdout;

    expect(await collectWorkingTreeChanges(root)).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "staged.ts", status: "modified", diff: expect.stringContaining("+new staged") }),
      expect.objectContaining({ path: "unstaged.ts", status: "modified", diff: expect.stringContaining("+new unstaged") }),
      expect.objectContaining({ path: "new.ts", previousPath: "old.ts", status: "renamed" }),
      expect.objectContaining({ path: "deleted.ts", status: "deleted", deletions: 1 }),
      expect.objectContaining({ path: "untracked.ts", status: "added", additions: 1, diff: expect.stringContaining("+new untracked") })
    ]));
    expect((await git(root, "diff", "--cached")).stdout).toBe(indexBefore);
    expect((await git(root, "show-ref")).stdout).not.toContain("refs/cake/");
  });

  it("limits inspection to a subdirectory workspace", async () => {
    const root = await repository();
    const workspace = join(root, "packages", "app");
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, "index.ts"), "export const value = 1;\n");
    await writeFile(join(root, "outside.ts"), "outside one\n");
    await commit(root);
    await writeFile(join(workspace, "index.ts"), "export const value = 2;\n");
    await writeFile(join(root, "outside.ts"), "outside two\n");

    expect(await collectWorkingTreeChanges(workspace)).toEqual([
      expect.objectContaining({ path: "index.ts", status: "modified" })
    ]);
  });

  it("supports unborn repositories", async () => {
    const root = await repository();
    await writeFile(join(root, "index.ts"), "export {};\n");
    expect(await collectWorkingTreeChanges(root)).toEqual([
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
