import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  defaultProjectSettings,
  type ProjectSettings,
} from "../../src/contracts/application/application-data";
import { makeTestWorktreeService, type TestWorktreeService } from "../helpers/worktree-service";

const execFileAsync = promisify(execFile);
const directories: string[] = [];
const services: TestWorktreeService[] = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.dispose()));
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function git(cwd: string, ...args: string[]) {
  return (await execFileAsync("git", args, { cwd })).stdout.trim();
}

/** A repository whose registered Project is the `system/app` subdirectory. */
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cake-configured-worktrees-")));
  directories.push(root);
  const repo = join(root, "world", "src");
  const project = join(repo, "system", "app");
  await mkdir(project, { recursive: true });
  await git(repo, "init", "-b", "main");
  await git(repo, "config", "user.email", "cake@example.test");
  await git(repo, "config", "user.name", "Cake Test");
  await writeFile(join(project, "app.txt"), "base\n");
  await git(repo, "add", "-A");
  await git(repo, "commit", "-m", "base");
  return { root, repo, project, trees: join(root, "trees") };
}

function service(root: string, settings?: ProjectSettings) {
  const worktrees = makeTestWorktreeService(join(root, "worktrees.json"), settings);
  services.push(worktrees);
  return worktrees;
}

/** Settings for a tool that, like `dev tree`, chooses `<trees>/<name>/src` itself. */
const treeTool = (trees: string, remove?: string): ProjectSettings => ({
  ...defaultProjectSettings(),
  worktreeCreateCommand: `git worktree add '${trees}'/{worktreeName}/src {branchName}`,
  worktreeRemoveCommand:
    remove ??
    [
      `echo remove {worktreeName} {removeReason} >> '${trees}/removals'`,
      `case {removeReason} in resolve) force= ;; *) force=--force ;; esac`,
      `git worktree remove $force '${trees}'/{worktreeName}/src`,
      `rmdir '${trees}'/{worktreeName}`,
    ].join("\n"),
  worktreeCommandTimeoutSeconds: 60,
  worktreeLanding: "pull-request",
});

describe("Configured worktree lifecycle", { timeout: 30_000 }, () => {
  it("runs sessions in the project's subdirectory of a built-in checkout", async () => {
    const { root, repo, project } = await fixture();
    const worktrees = service(root);
    const record = await worktrees.create(project, undefined, "subdir");
    const checkout = join(root, "world", ".src-worktrees", record.branch.slice("agent/".length));
    expect(record).toMatchObject({
      projectPath: project,
      checkoutPath: checkout,
      worktreePath: join(checkout, "system", "app"),
    });
    expect(await readFile(join(record.worktreePath, "app.txt"), "utf8")).toBe("base\n");
    await worktrees.discard(record.worktreePath, false);
    expect(existsSync(checkout)).toBe(false);
    await expect(git(repo, "branch", "--list", record.branch)).resolves.toBe("");
  });

  it("learns a tool-chosen location, retires clean trees, keeps dirty ones and restores in place", async () => {
    const { root, repo, project, trees } = await fixture();
    const worktrees = service(root, treeTool(trees));
    const settings = treeTool(trees);
    const clean = await worktrees.create(project, undefined, "clean", settings);
    const name = clean.branch.slice("agent/".length);
    expect(clean).toMatchObject({
      checkoutPath: join(trees, name, "src"),
      worktreePath: join(trees, name, "src", "system", "app"),
    });
    expect(await git(clean.worktreePath, "rev-parse", "--abbrev-ref", "HEAD")).toBe(clean.branch);
    await writeFile(join(clean.worktreePath, "app.txt"), "change\n");
    await git(clean.worktreePath, "commit", "-am", "change");
    const dirty = await worktrees.create(project, undefined, "dirty", settings);
    await writeFile(join(dirty.worktreePath, "draft.txt"), "unsaved\n");

    await expect(
      worktrees.cleanupResolved(clean.worktreePath, { retireActive: true }),
    ).resolves.toBe(true);
    expect(existsSync(join(trees, name))).toBe(false);
    // The branch keeps the unmerged commit for review or a later restore.
    expect(await git(repo, "log", "-1", "--format=%s", clean.branch)).toBe("change");
    await expect(
      worktrees.cleanupResolved(dirty.worktreePath, { retireActive: true }),
    ).resolves.toBe(false);
    expect(await readFile(join(dirty.worktreePath, "draft.txt"), "utf8")).toBe("unsaved\n");
    expect((await worktrees.records()).map((record) => [record.branch, record.state])).toEqual([
      [clean.branch, "resolved"],
      [dirty.branch, "active"],
    ]);

    await expect(worktrees.restoreResolved(clean.worktreePath)).resolves.toMatchObject({
      worktreePath: clean.worktreePath,
      state: "active",
    });
    expect(await readFile(join(clean.worktreePath, "app.txt"), "utf8")).toBe("change\n");

    await worktrees.discard(clean.worktreePath, false);
    expect(existsSync(join(trees, name))).toBe(false);
    await expect(git(repo, "branch", "--list", clean.branch)).resolves.toBe("");
    expect(await readFile(join(trees, "removals"), "utf8")).toBe(
      `remove ${name} resolve\nremove ${name} discard\n`,
    );
  });

  it("rolls back a failed configured creation and reports its log", async () => {
    const { root, repo, project, trees } = await fixture();
    const worktrees = service(root);
    const error = await worktrees
      .create(project, undefined, "broken", {
        ...treeTool(trees),
        worktreeCreateCommand: `echo "no tree for you" >&2; exit 7`,
      })
      .then(
        () => undefined,
        (cause: unknown) => cause,
      );
    expect(String(error)).toContain("failed with exit code 7");
    expect(String(error)).toContain("no tree for you");
    await expect(git(repo, "branch", "--list", "agent/broken-*")).resolves.toBe("");
    await expect(worktrees.records()).resolves.toEqual([]);
  });

  it("refuses to report removal when the configured command left the checkout", async () => {
    const { root, project, trees } = await fixture();
    const settings = treeTool(trees, "true");
    const worktrees = service(root, settings);
    const record = await worktrees.create(project, undefined, "stuck", settings);
    await expect(worktrees.discard(record.worktreePath, false)).rejects.toThrow("still exists");
    expect(existsSync(record.worktreePath)).toBe(true);
    await expect(worktrees.records()).resolves.toEqual([
      expect.objectContaining({ worktreePath: record.worktreePath, state: "active" }),
    ]);
  });
});
