import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { collectWorkspaceChanges, parsePorcelainV2 } from "../../../src/main/git-changes";

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
  await git(cwd, "-c", "user.name=Cake Test", "-c", "user.email=cake@example.test", "commit", "-m", "baseline");
}

describe("collectWorkspaceChanges", () => {
  it("collects cumulative staged, unstaged, untracked, deleted, and renamed changes", async () => {
    const root = await repository();
    await writeFile(join(root, "old.ts"), "export const old = true;\n");
    await writeFile(join(root, "mixed.ts"), "one\n");
    await writeFile(join(root, "deleted.ts"), "remove me\n");
    await commit(root);

    await git(root, "mv", "old.ts", "new.ts");
    await writeFile(join(root, "mixed.ts"), "two\n");
    await git(root, "add", "mixed.ts");
    await writeFile(join(root, "mixed.ts"), "three\n");
    await rm(join(root, "deleted.ts"));
    await writeFile(join(root, "fresh.ts"), "export const fresh = true;\n");

    const changes = await collectWorkspaceChanges(root);

    expect(changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "new.ts", previousPath: "old.ts", status: "renamed", staged: true, additions: 0, deletions: 0 }),
      expect.objectContaining({ path: "mixed.ts", status: "modified", staged: true, unstaged: true, additions: 1, deletions: 1, diff: expect.stringContaining("+three") }),
      expect.objectContaining({ path: "deleted.ts", status: "deleted", staged: false, unstaged: true, additions: 0, deletions: 1 }),
      expect.objectContaining({ path: "fresh.ts", status: "untracked", staged: false, unstaged: true, additions: 1, deletions: 0 })
    ]));
  });

  it("supports unborn repositories and workspace subdirectories", async () => {
    const root = await repository();
    const workspace = join(root, "packages", "app");
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, "index.ts"), "export {};\n");
    await writeFile(join(root, "outside.ts"), "ignored by this workspace\n");

    const changes = await collectWorkspaceChanges(workspace);

    expect(changes).toEqual([
      expect.objectContaining({ path: "index.ts", status: "untracked", additions: 1 })
    ]);
  });
});

describe("parsePorcelainV2", () => {
  it("preserves both sides of NUL-delimited rename records and spaces in paths", () => {
    const output = "2 R. N... 100644 100644 100644 aaaaaaa bbbbbbb R100 src/new name.ts\0src/old name.ts\0? notes/new file.md\0";

    expect(parsePorcelainV2(output)).toEqual([
      { path: "src/new name.ts", previousPath: "src/old name.ts", indexStatus: "R", worktreeStatus: "." },
      { path: "notes/new file.md", indexStatus: "?", worktreeStatus: "?", untracked: true }
    ]);
  });
});
