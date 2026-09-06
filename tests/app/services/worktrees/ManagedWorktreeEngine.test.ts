import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type GitRunner } from "../../../../src/services/git/Git";
import { makeTestWorktreeStorageRepository } from "../../../helpers/worktree-storage-repository";
import { ManagedWorktreeEngine } from "../../../../src/services/worktrees/ManagedWorktreeEngine";
import type { WorktreeRecord } from "../../../../src/ipc/worktree-contract";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

interface GitState {
  /** Branch the repository is checked out on when the worktree is created. */
  repoBranch: string;
  /** Branch reported for the landing target (`rev-parse --abbrev-ref HEAD`). */
  targetBranch: string;
  /** `rev-parse HEAD` inside the worktree. */
  head: string;
  /** `rev-parse HEAD` on the landing target. */
  targetHead: string;
  /** `rev-list --count base..HEAD` inside the worktree. */
  ahead: string;
  /** `status --porcelain` inside the worktree. */
  dirty: string;
  /** `status --porcelain` on the landing target. */
  targetDirty: string;
  /** `diff --name-only --diff-filter=U` inside the worktree. */
  unmerged: string;
  /** Whether a rebase is paused inside the worktree. */
  rebasing: boolean;
}

/**
 * A cwd-aware fake git runner. The setup registers the paths the service
 * creates, and every invocation is classified as `repo`, `target`, or
 * `worktree` so the same command can answer differently per checkout.
 */
function fakeGit(state: GitState, paths: { root: string; worktree?: string; project?: string }) {
  const invocations: Array<{ where: string; args: string[] }> = [];
  const where = (cwd: string) =>
    cwd === paths.worktree ? "worktree" : cwd === paths.project ? "target" : "repo";
  const runner: GitRunner = async (cwd, args) => {
    const at = where(cwd);
    invocations.push({ where: at, args: [...args] });
    if (args[0] === "rev-parse") {
      if (args[1] === "--show-toplevel") return `${paths.root}\n`;
      if (args[1] === "--abbrev-ref")
        return `${at === "repo" ? state.repoBranch : state.targetBranch}\n`;
      if (args[1] === "--git-path") return state.rebasing ? ".git/rebase-merge\n" : "\n";
      if (args[1] === "--verify") throw new Error(`fake git: no ref ${args[3] ?? ""}`);
      if (args[1] === "HEAD") return `${at === "worktree" ? state.head : state.targetHead}\n`;
      return "c-base\n";
    }
    if (args[0] === "rev-list") return `${state.ahead}\n`;
    if (args[0] === "status") return at === "worktree" ? state.dirty : state.targetDirty;
    if (args[0] === "diff") return `${state.unmerged}\n`;
    if (args[0] === "symbolic-ref") throw new Error("fake git: no origin HEAD");
    if (args[0] === "merge-tree") return "";
    if (args[0] === "merge" || args[0] === "rebase" || args[0] === "worktree") return "";
    if (args[0] === "branch" || args[0] === "commit") return "";
    throw new Error(`fake git cannot handle: ${args.join(" ")}`);
  };
  return { runner, invocations };
}

async function setup(mutate: (state: GitState) => void = () => undefined): Promise<{
  service: ManagedWorktreeEngine;
  record: WorktreeRecord;
  state: GitState;
  storage: string;
  invocations: Array<{ where: string; args: string[] }>;
}> {
  const repository = await mkdtemp(join(tmpdir(), "cake-worktree-unit-"));
  directories.push(repository);
  const state: GitState = {
    repoBranch: "main",
    targetBranch: "main",
    head: "c-head",
    targetHead: "c-target",
    ahead: "1",
    dirty: "",
    targetDirty: "",
    unmerged: "",
    rebasing: false,
  };
  mutate(state);
  const paths: { root: string; worktree?: string; project?: string } = { root: repository };
  const { runner, invocations } = fakeGit(state, paths);
  const storage = join(repository, "worktrees.json");
  const service = new ManagedWorktreeEngine(makeTestWorktreeStorageRepository(storage), runner);
  const record = await service.create(join(repository, "project"), undefined, "widget");
  paths.worktree = record.worktreePath;
  paths.project = record.projectPath;
  directories.push(record.worktreePath);
  await mkdir(record.projectPath, { recursive: true });
  await mkdir(record.worktreePath, { recursive: true });
  if (state.rebasing)
    await mkdir(join(record.worktreePath, ".git", "rebase-merge"), { recursive: true });
  return { service, record, state, storage, invocations };
}

describe("WorktreeService decision logic", () => {
  it("persists records across service instances", async () => {
    const { service, record, storage } = await setup();
    await expect(service.records()).resolves.toEqual([record]);
    await expect(readFile(storage, "utf8")).resolves.toContain(record.branch);
    await expect(
      new ManagedWorktreeEngine(
        makeTestWorktreeStorageRepository(storage),
        async () => "",
      ).records(),
    ).resolves.toEqual([record]);
  });

  it("pauses squash landing for a proposal and lands once it is proposed", async () => {
    const { service, record, state } = await setup();
    await expect(
      service.land(record.worktreePath, { request: { strategy: "squash" } }),
    ).resolves.toEqual({ outcome: "proposal" });

    await service.proposeSquashMessage({ workspacePath: record.worktreePath, subject: "Squash" });
    await expect(
      service.land(record.worktreePath, { request: { strategy: "squash" } }),
    ).resolves.toEqual({ outcome: "landed", commit: state.targetHead });
    const [landed] = await service.records();
    expect(landed).toMatchObject({ state: "landed" });
    expect(landed && "pendingStrategy" in landed).toBe(false);
  });

  it("does not consume a proposal whose worktree tip has moved", async () => {
    const { service, record, state } = await setup();
    await expect(
      service.land(record.worktreePath, { request: { strategy: "squash" } }),
    ).resolves.toEqual({ outcome: "proposal" });
    await service.proposeSquashMessage({ workspacePath: record.worktreePath, subject: "Stale" });

    state.head = "c-moved";
    await expect(
      service.land(record.worktreePath, { request: { strategy: "squash" } }),
    ).resolves.toEqual({ outcome: "proposal" });

    state.head = "c-head";
    await expect(
      service.land(record.worktreePath, { request: { strategy: "squash" } }),
    ).resolves.toEqual({ outcome: "proposal" });
    await service.proposeSquashMessage({ workspacePath: record.worktreePath, subject: "Fresh" });
    await expect(
      service.land(record.worktreePath, { request: { strategy: "squash" } }),
    ).resolves.toMatchObject({ outcome: "landed" });
  });

  it("resumes resolving instead of failing when a landing is retried mid-rebase", async () => {
    const { service, record } = await setup((state) => {
      state.rebasing = true;
      state.unmerged = "shared.txt";
    });
    await expect(
      service.land(record.worktreePath, { request: { strategy: "preserve" } }),
    ).resolves.toEqual({ outcome: "resolving", files: ["shared.txt"] });
    await expect(
      service.land(record.worktreePath, { request: { strategy: "squash" } }),
    ).resolves.toMatchObject({ outcome: "resolving" });
    await expect(service.records()).resolves.toEqual([
      expect.objectContaining({ pendingStrategy: "squash" }),
    ]);
  });

  it("refuses to land a dirty worktree or a dirty canonical checkout", async () => {
    const dirtyWorktree = await setup((state) => {
      state.dirty = " M feature.ts\n";
    });
    await expect(
      dirtyWorktree.service.land(dirtyWorktree.record.worktreePath, {
        request: { strategy: "preserve" },
      }),
    ).rejects.toThrow(/uncommitted changes/i);

    const dirtyTarget = await setup((state) => {
      state.targetDirty = "?? scratch.txt\n";
    });
    await expect(
      dirtyTarget.service.land(dirtyTarget.record.worktreePath, {
        request: { strategy: "preserve" },
      }),
    ).rejects.toThrow(/landing target has uncommitted changes/i);
    await expect(
      dirtyTarget.service.land(dirtyTarget.record.worktreePath, {
        request: { strategy: "preserve", allowDirtyTarget: true },
      }),
    ).resolves.toMatchObject({ outcome: "landed" });
  });

  it("refuses to land while the canonical checkout is on another branch", async () => {
    const { service, record } = await setup((state) => {
      state.targetBranch = "exploration";
    });
    await expect(
      service.land(record.worktreePath, { request: { strategy: "preserve" } }),
    ).rejects.toThrow(/back to "main"/i);
  });

  it("lands with nothing ahead without touching the target", async () => {
    const { service, record, invocations } = await setup((state) => {
      state.ahead = "0";
    });
    await expect(
      service.land(record.worktreePath, { request: { strategy: "squash" } }),
    ).resolves.toEqual({ outcome: "landed" });
    await expect(service.records()).resolves.toEqual([
      expect.objectContaining({ state: "landed" }),
    ]);
    expect(invocations.filter(({ args }) => args[0] === "merge")).toEqual([]);
  });

  it("queues repository landings until the active conflict-resolution workflow releases", async () => {
    const { service, record: first, state } = await setup();
    const second = await service.create(first.projectPath, undefined, "second");
    directories.push(second.worktreePath);
    await mkdir(second.worktreePath, { recursive: true });
    state.rebasing = true;
    await Promise.all(
      [first.worktreePath, second.worktreePath].map((path) =>
        mkdir(join(path, ".git", "rebase-merge"), { recursive: true }),
      ),
    );

    await service.prepareLanding(first.worktreePath, "landing-1");
    await expect(
      service.land(first.worktreePath, {
        operationId: "landing-1",
        request: { strategy: "preserve" },
      }),
    ).resolves.toMatchObject({ outcome: "resolving" });

    let secondStarted = false;
    const queued = service.prepareLanding(second.worktreePath, "landing-2").then(() => {
      secondStarted = true;
    });
    await expect
      .poll(() => service.status(second.worktreePath).then((status) => status?.landingState))
      .toBe("queued");
    await expect(service.status(second.worktreePath)).resolves.toMatchObject({
      landingOperationId: "landing-2",
      landingQueuePosition: 1,
    });
    expect(secondStarted).toBe(false);

    state.rebasing = false;
    await rm(join(first.worktreePath, ".git", "rebase-merge"), {
      recursive: true,
      force: true,
    });
    await expect(
      service.land(first.worktreePath, {
        operationId: "landing-1",
        request: { strategy: "preserve" },
      }),
    ).resolves.toMatchObject({ outcome: "landed" });
    await queued;
    expect(secondStarted).toBe(true);
    await expect(service.status(second.worktreePath)).resolves.toMatchObject({
      landingState: "running",
      landingOperationId: "landing-2",
    });
    await service.cancelLanding(second.worktreePath, "landing-2");
  });

  it("advances waiting landings in FIFO order when paused reservations are canceled", async () => {
    const { service, record: first } = await setup();
    const second = await service.create(first.projectPath, undefined, "second");
    const third = await service.create(first.projectPath, undefined, "third");
    for (const record of [second, third]) {
      directories.push(record.worktreePath);
      await mkdir(record.worktreePath, { recursive: true });
    }
    await service.prepareLanding(first.worktreePath, "landing-1");
    const started: string[] = [];
    const secondReady = service.prepareLanding(second.worktreePath, "landing-2").then(() => {
      started.push("second");
    });
    await expect
      .poll(() => service.status(second.worktreePath))
      .toMatchObject({
        landingState: "queued",
        landingQueuePosition: 1,
      });
    const thirdReady = service.prepareLanding(third.worktreePath, "landing-3").then(() => {
      started.push("third");
    });
    await expect
      .poll(() => service.status(third.worktreePath))
      .toMatchObject({
        landingState: "queued",
        landingQueuePosition: 2,
      });
    await service.cancelLanding(first.worktreePath, "landing-1");
    await secondReady;
    expect(started).toEqual(["second"]);
    await service.cancelLanding(second.worktreePath, "landing-2");
    await thirdReady;
    expect(started).toEqual(["second", "third"]);
    await service.cancelLanding(third.worktreePath, "landing-3");
    expect((await service.status(third.worktreePath))?.landingState).toBeUndefined();
  });

  it("blocks landing a parent while child worktrees are active", async () => {
    const { service, record: parent, state } = await setup();
    const child = await service.create(parent.projectPath, parent.worktreePath, "child");
    directories.push(child.worktreePath);
    await mkdir(child.worktreePath, { recursive: true });
    await expect(
      service.land(parent.worktreePath, { request: { strategy: "preserve" } }),
    ).rejects.toThrow(/active child worktrees/i);

    await service.discard(child.worktreePath, false);
    await expect(service.records()).resolves.toEqual([
      expect.objectContaining({ branch: parent.branch, state: "active" }),
      expect.objectContaining({ branch: child.branch, state: "discarded" }),
    ]);
    await expect(
      service.land(parent.worktreePath, { request: { strategy: "preserve" } }),
    ).resolves.toEqual({ outcome: "landed", commit: state.targetHead });
  });

  it("marks worktree directories deleted outside Cake as missing", async () => {
    const { service, record } = await setup();
    await rm(record.worktreePath, { recursive: true, force: true });
    await expect(service.status(record.worktreePath)).resolves.toBeUndefined();
    await expect(service.records()).resolves.toEqual([
      expect.objectContaining({ state: "missing" }),
    ]);
    const next = await service.create(record.projectPath, undefined, "next");
    directories.push(next.worktreePath);
    expect(next).toMatchObject({ state: "active" });
    expect(next.branch).toMatch(/^agent\/next-[a-f0-9]{6}$/);
  });
});
