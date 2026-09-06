import { Schema } from "effect";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import {
  worktreeStatusSchema,
  type WorktreeLandOutcome,
  type WorktreeLandRequest,
  type WorktreeLandingCoordinator,
  type WorktreeRebaseOutcome,
  type WorktreeRecord,
  type WorktreeStatus,
} from "../../ipc/worktree-contract";
import type { ProjectSettings } from "../../domain/application-data";
import type { GitRunner } from "../git/Git";
import type { WorktreeStorageRepository } from "../storage/WorktreeStorage";
import { renderWorktreeCommand } from "./worktree-command-template";

export type WorktreeCommandRunner = (workingDirectory: string, script: string) => Promise<void>;

interface LandOptions {
  request: WorktreeLandRequest;
  operationId?: string;
  signal?: AbortSignal;
}

interface LandingQueueEntry {
  readonly operationId: string;
  readonly worktreePath: string;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
  readonly signal?: AbortSignal;
  abort?: () => void;
}

interface RepositoryLandingQueue {
  active?: LandingQueueEntry;
  readonly pending: LandingQueueEntry[];
}

/**
 * Creates, inspects, lands, and cleans up Cake-managed Git worktrees.
 *
 * Each record is one isolated checkout in a sibling directory of its
 * repository, paired with an `agent/`-namespaced branch. Cake owns the whole
 * lifecycle. Landing either replays the branch commits onto the target branch
 * or squashes them into one commit. Resolving the associated sessions removes
 * the checkout, and restoring a session recreates it from the landing target.
 * Conflict resolution and squash-message
 * proposals are delegated to the worktree's session agent through the Cake
 * gateway, and landing is retried once the agent finishes.
 */
export class ManagedWorktreeEngine implements WorktreeLandingCoordinator {
  private allRecords: WorktreeRecord[] = [];
  private loaded = false;
  private readonly repositoryOperationTails = new Map<string, Promise<void>>();
  /** One user-visible landing workflow at a time may target a repository. */
  private readonly repositoryLandingQueues = new Map<string, RepositoryLandingQueue>();
  /**
   * Proposed squash commit messages keyed by worktree path. A proposal is only
   * valid while both the worktree tip and the target tip are unchanged since it
   * was recorded; either moving invalidates it.
   */
  private readonly squashProposals = new Map<
    string,
    { message: string; head: string; targetHead: string }
  >();
  /** Worktrees whose session agent has been asked for a squash commit message. */
  private readonly awaitingSquashProposals = new Set<string>();
  constructor(
    private readonly storage: WorktreeStorageRepository,
    private readonly gitRunner: GitRunner,
    private readonly commandRunner?: WorktreeCommandRunner,
  ) {}

  async records(): Promise<WorktreeRecord[]> {
    await this.load();
    return [...this.allRecords];
  }

  /**
   * Creates another managed worktree for the repository. Projects may have any
   * number of concurrent worktrees; each is an isolated checkout and branch.
   */
  async create(
    projectPath: string,
    baseWorktreePath?: string,
    worktreeName?: string,
    settings?: ProjectSettings,
  ): Promise<WorktreeRecord> {
    await this.load();
    const registeredProjectPath = resolveNormalized(projectPath);
    const root = await realpath(await this.repositoryRoot(projectPath));
    return this.withRepositoryLock(root, () =>
      this.createRecord(root, registeredProjectPath, baseWorktreePath, worktreeName, settings),
    );
  }

  private async createRecord(
    root: string,
    registeredProjectPath: string,
    baseWorktreePath?: string,
    worktreeName?: string,
    settings?: ProjectSettings,
  ): Promise<WorktreeRecord> {
    const parent = baseWorktreePath
      ? this.allRecords.find(
          (entry) =>
            ["active", "landed"].includes(entry.state ?? "active") &&
            resolveNormalized(entry.worktreePath) === resolveNormalized(baseWorktreePath),
        )
      : undefined;
    if (baseWorktreePath && (!parent || parent.projectPath !== registeredProjectPath))
      throw new Error("Cake could not find that base worktree");
    if (parent && !existsSync(parent.worktreePath))
      throw new Error("The base worktree no longer exists");
    if (parent && (await this.dirtyFileCount(parent.worktreePath)) > 0)
      throw new Error("Commit the base worktree before creating a child worktree.");

    const baseBranch = parent?.branch ?? (await this.defaultBranch(root));
    const startPoint = parent?.branch ?? baseBranch;
    const baseCommit = (await this.git(root, "rev-parse", startPoint)).trim();
    const slug = slugify(basename(root));
    const requestedName = worktreeName ?? slug;
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(requestedName)) throw new Error("Invalid worktree name");
    const worktreesDir = join(dirname(root), `.${slug}-worktrees`);
    const name = await this.availableWorktreeName(root, worktreesDir, requestedName);
    const branch = `agent/${name}`;
    const worktreePath = join(worktreesDir, name);
    await mkdir(worktreesDir, { recursive: true });
    const variables = {
      projectPath: registeredProjectPath,
      worktreePath,
      worktreeName: name,
      branchName: branch,
      baseBranch,
      baseCommit,
    };
    try {
      if (settings?.worktreeCreateCommand.trim()) {
        if (!this.commandRunner) throw new Error("Worktree command execution is unavailable");
        await this.commandRunner(
          root,
          renderWorktreeCommand(settings.worktreeCreateCommand, variables),
        );
        if (!existsSync(worktreePath))
          throw new Error("The worktree creation command did not create {worktreePath}");
        const createdBranch = (
          await this.git(worktreePath, "rev-parse", "--abbrev-ref", "HEAD")
        ).trim();
        if (createdBranch !== branch)
          throw new Error(
            `The worktree creation command checked out ${createdBranch}, not ${branch}`,
          );
      } else await this.git(root, "worktree", "add", "-b", branch, worktreePath, baseCommit);
      if (settings?.worktreeSetupCommands.trim()) {
        if (!this.commandRunner) throw new Error("Worktree setup command execution is unavailable");
        await this.commandRunner(
          worktreePath,
          renderWorktreeCommand(settings.worktreeSetupCommands, variables),
        );
      }
    } catch (error) {
      await this.git(root, "worktree", "remove", "--force", worktreePath).catch(() => undefined);
      await this.git(root, "branch", "-D", branch).catch(() => undefined);
      throw error;
    }
    const recordBase = {
      projectPath: registeredProjectPath,
      worktreePath,
      branch,
      baseBranch,
      baseCommit,
      state: "active" as const,
      createdAt: new Date().toISOString(),
    };
    const record: WorktreeRecord = parent
      ? { ...recordBase, parentWorktreePath: parent.worktreePath }
      : recordBase;
    this.allRecords = [...this.allRecords, record];
    await this.persist();
    return record;
  }

  async status(worktreePath: string): Promise<WorktreeStatus | undefined> {
    await this.load();
    const normalized = resolveNormalized(worktreePath);
    const record = this.allRecords.find(
      (entry) => resolveNormalized(entry.worktreePath) === normalized,
    );
    if (!record || !["active", "landed"].includes(record.state ?? "active")) return undefined;
    if (!existsSync(record.worktreePath)) {
      // Preserve the historical checkout association so its transcripts remain discoverable.
      await this.git(record.projectPath, "worktree", "prune").catch(() => undefined);
      await this.closeRecord(record, "missing");
      return undefined;
    }
    const targetPath = record.parentWorktreePath ?? record.projectPath;
    if (!existsSync(targetPath)) throw new Error("The worktree landing target no longer exists");
    const [
      dirtyCount,
      aheadCount,
      behindCount,
      merged,
      targetDirty,
      targetBranch,
      merging,
      rebasing,
    ] = await Promise.all([
      this.dirtyFileCount(record.worktreePath),
      this.revListCount(record.worktreePath, `${record.baseBranch}..HEAD`),
      this.revListCount(record.worktreePath, `HEAD..${record.baseBranch}`),
      record.state === "landed"
        ? Promise.resolve(true)
        : this.isAncestor(record.worktreePath, "HEAD", record.baseBranch),
      this.dirtyFileCount(targetPath).then((count) => count > 0),
      this.gitWithFallback(targetPath, ["rev-parse", "--abbrev-ref", "HEAD"]),
      this.revParseExists(record.worktreePath, "MERGE_HEAD"),
      this.rebaseInProgress(record.worktreePath),
    ]);
    const landing = this.landingState(record);
    return Schema.decodeUnknownSync(worktreeStatusSchema)({
      record,
      targetBranch: record.baseBranch,
      dirtyCount,
      aheadCount,
      behindCount,
      merged,
      targetDirty,
      targetOnBranch: targetBranch === record.baseBranch,
      merging,
      rebasing,
      squashMessageReady: await this.hasFreshSquashProposal(record),
      ...(landing?.state === "queued"
        ? {
            landingState: landing.state,
            landingOperationId: landing.operationId,
            landingQueuePosition: landing.position,
          }
        : landing
          ? { landingState: landing.state, landingOperationId: landing.operationId }
          : {}),
    });
  }

  /** Replays this worktree's commits when its base branch has advanced. */
  async rebase(worktreePath: string): Promise<WorktreeRebaseOutcome> {
    await this.load();
    const normalized = resolveNormalized(worktreePath);
    const record = this.allRecords.find(
      (entry) =>
        (entry.state ?? "active") === "active" &&
        resolveNormalized(entry.worktreePath) === normalized,
    );
    if (!record) throw new Error("Cake could not find that active worktree");
    return this.withRepositoryLock(record.projectPath, async () => {
      if (!existsSync(record.worktreePath)) {
        await this.closeRecord(record, "missing");
        throw new Error("The worktree no longer exists on disk");
      }
      if (await this.rebaseInProgress(record.worktreePath))
        return { outcome: "resolving", files: await this.unmergedFiles(record.worktreePath) };
      if ((await this.dirtyFileCount(record.worktreePath)) > 0)
        throw new Error("The worktree has uncommitted changes. Commit or discard them first.");
      const targetPath = record.parentWorktreePath ?? record.projectPath;
      if (!existsSync(targetPath)) throw new Error("The worktree rebase target no longer exists");
      const targetHead = (
        await this.git(record.worktreePath, "rev-parse", record.baseBranch)
      ).trim();
      const behindCount = await this.revListCount(record.worktreePath, `HEAD..${targetHead}`);
      if (behindCount === 0) return { outcome: "rebased" };
      const conflicts = await this.rebaseOntoTarget(record, targetHead);
      return conflicts ? { outcome: "resolving", files: conflicts } : { outcome: "rebased" };
    });
  }

  /**
   * Lands the worktree branch into its base branch and marks it as landed.
   * With the `preserve` strategy the commits are replayed onto the target and
   * fast-forwarded; with `squash` they become one target commit. Conflicts and
   * missing squash messages pause the landing for the session agent; call
   * again once the agent has finished to continue.
   */
  async land(worktreePath: string, options: LandOptions): Promise<WorktreeLandOutcome> {
    await this.load();
    const normalized = resolveNormalized(worktreePath);
    const record = this.allRecords.find(
      (entry) =>
        (entry.state ?? "active") === "active" &&
        resolveNormalized(entry.worktreePath) === normalized,
    );
    if (!record) throw new Error("Cake could not find that active worktree");
    const operationId = options.operationId ?? `direct:${normalized}`;
    await this.acquireLanding(record, operationId, options.signal);
    try {
      const outcome = await this.withRepositoryLock(record.projectPath, () =>
        this.landRecord(record, options),
      );
      if (outcome.outcome === "landed") this.releaseLanding(record, operationId);
      return outcome;
    } catch (error) {
      this.releaseLanding(record, operationId);
      throw error;
    }
  }

  /** Reserves this repository's landing slot before agent-assisted preparation begins. */
  async prepareLanding(
    worktreePath: string,
    operationId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.load();
    const normalized = resolveNormalized(worktreePath);
    const record = this.allRecords.find(
      (entry) =>
        (entry.state ?? "active") === "active" &&
        resolveNormalized(entry.worktreePath) === normalized,
    );
    if (!record) throw new Error("Cake could not find that active worktree");
    await this.acquireLanding(record, operationId, signal);
  }

  /** Cancels a paused or queued landing and advances the next repository entry. */
  async cancelLanding(worktreePath: string, operationId: string): Promise<void> {
    await this.load();
    const normalized = resolveNormalized(worktreePath);
    const record = this.allRecords.find(
      (entry) => resolveNormalized(entry.worktreePath) === normalized,
    );
    if (!record) return;
    const queue = this.repositoryLandingQueues.get(record.projectPath);
    if (!queue) return;
    if (queue.active?.operationId === operationId) {
      this.releaseLanding(record, operationId);
      return;
    }
    const index = queue.pending.findIndex((entry) => entry.operationId === operationId);
    if (index < 0) return;
    const [entry] = queue.pending.splice(index, 1);
    entry?.abort?.();
    entry?.reject(new Error("Worktree landing was canceled."));
    if (!queue.active && queue.pending.length === 0)
      this.repositoryLandingQueues.delete(record.projectPath);
  }

  private async landRecord(
    record: WorktreeRecord,
    options: LandOptions,
  ): Promise<WorktreeLandOutcome> {
    if (!existsSync(record.worktreePath)) {
      await this.closeRecord(record, "missing");
      throw new Error("The worktree no longer exists on disk");
    }
    // A previous landing may have paused mid-rebase or mid-merge; the session
    // agent must finish that state before any new landing Git operations.
    if (
      (await this.rebaseInProgress(record.worktreePath)) ||
      (await this.revParseExists(record.worktreePath, "MERGE_HEAD"))
    ) {
      await this.rememberPendingLanding(record, options.request.strategy);
      return { outcome: "resolving", files: await this.unmergedFiles(record.worktreePath) };
    }
    if ((await this.dirtyFileCount(record.worktreePath)) > 0)
      throw new Error("The worktree has uncommitted changes. Commit or discard them first.");
    const targetPath = record.parentWorktreePath ?? record.projectPath;
    if (!existsSync(targetPath)) throw new Error("The worktree landing target no longer exists");
    if (
      (await this.git(targetPath, "rev-parse", "--abbrev-ref", "HEAD")).trim() !== record.baseBranch
    )
      throw new Error(`Switch the landing target back to "${record.baseBranch}" first.`);
    if ((await this.dirtyFileCount(targetPath)) > 0 && !options.request.allowDirtyTarget)
      throw new Error("The landing target has uncommitted changes. Commit or stash them first.");
    const activeChildren = this.allRecords.filter(
      (entry) =>
        (entry.state ?? "active") === "active" &&
        entry.parentWorktreePath === record.worktreePath &&
        existsSync(entry.worktreePath),
    );
    if (activeChildren.length > 0)
      throw new Error("Land or discard this worktree's active child worktrees first.");

    const aheadCount = await this.revListCount(record.worktreePath, `${record.baseBranch}..HEAD`);
    if (aheadCount === 0) {
      await this.closeRecord(record, "landed");
      return { outcome: "landed" };
    }

    if (options.request.strategy === "squash") {
      const outcome = await this.landSquash(record, options.request.message);
      if (outcome.outcome !== "landed")
        await this.rememberPendingLanding(record, options.request.strategy);
      return outcome;
    }

    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const conflicts = await this.rebaseOntoTarget(record);
      if (conflicts) {
        await this.rememberPendingLanding(record, "preserve");
        return { outcome: "resolving", files: conflicts };
      }
      try {
        await this.git(targetPath, "merge", "--ff-only", record.branch);
        const commit = (await this.git(targetPath, "rev-parse", "HEAD")).trim();
        await this.closeRecord(record, "landed");
        return { outcome: "landed", commit };
      } catch (error) {
        // The target advanced while rebasing; replay onto the new tip and retry.
        lastError = error;
      }
    }
    const detail = lastError instanceof Error ? lastError.message : "unknown Git failure";
    throw new Error(`Cake could not fast-forward the landing target: ${detail}`);
  }

  /** Squashes the branch into one target commit, pausing for the session agent's message when needed. */
  private async landSquash(record: WorktreeRecord, message?: string): Promise<WorktreeLandOutcome> {
    const normalized = resolveNormalized(record.worktreePath);
    const targetPath = record.parentWorktreePath ?? record.projectPath;
    if (message) {
      // An explicit message is a proposal for the current worktree and target tips.
      const head = (await this.git(record.worktreePath, "rev-parse", "HEAD")).trim();
      const targetHead = (await this.git(targetPath, "rev-parse", "HEAD")).trim();
      this.squashProposals.set(normalized, { message, head, targetHead });
    }
    // Gate every target mutation on a fresh conflict prediction so a stale
    // proposal or a moved target can never leave the target checkout conflicted.
    const conflictedFiles = await this.dryRunConflicts(
      targetPath,
      record.baseBranch,
      record.branch,
    );
    if (conflictedFiles === null || conflictedFiles.length > 0) {
      // Resolve the combined result once: merge the target into the worktree so
      // the agent resolves every conflict a squash would hit in one pass.
      try {
        await this.git(record.worktreePath, "merge", "--no-ff", "--no-edit", record.baseBranch);
      } catch {
        // A non-zero exit with MERGE_HEAD present is the expected conflict path.
      }
      if (await this.revParseExists(record.worktreePath, "MERGE_HEAD")) {
        this.awaitingSquashProposals.add(normalized);
        return {
          outcome: "resolving",
          files: conflictedFiles ?? (await this.unmergedFiles(record.worktreePath)),
        };
      }
    }
    const requested = await this.consumeSquashProposal(record, targetPath);
    if (!requested) {
      this.awaitingSquashProposals.add(normalized);
      return { outcome: "proposal" };
    }
    const commit = await this.squashMergeAndMarkLanded(record, requested);
    return { outcome: "landed", commit };
  }

  /** Returns unmerged files when the rebase stops on conflicts, or null when it completed. */
  private async rebaseOntoTarget(
    record: WorktreeRecord,
    target: string = record.baseBranch,
  ): Promise<string[] | null> {
    try {
      await this.git(record.worktreePath, "rebase", target);
      return null;
    } catch (error) {
      if (await this.rebaseInProgress(record.worktreePath))
        return this.unmergedFiles(record.worktreePath);
      const detail = error instanceof Error ? error.message : "unknown Git failure";
      throw new Error(
        `Cake could not replay the worktree commits onto the target branch: ${detail}`,
        {
          cause: error,
        },
      );
    }
  }

  /**
   * Records a squash commit message proposed by the session agent through the
   * Cake gateway. The proposal is bound to the branch tip at proposal time so
   * later branch changes invalidate it.
   */
  async proposeSquashMessage(input: {
    workspacePath: string;
    subject: string;
    body?: string;
  }): Promise<void> {
    await this.load();
    const normalized = resolveNormalized(input.workspacePath);
    const record = this.allRecords.find(
      (entry) =>
        (entry.state ?? "active") === "active" &&
        resolveNormalized(entry.worktreePath) === normalized,
    );
    if (!record) throw new Error("Cake could not find an active worktree for this workspace");
    if (await this.revParseExists(record.worktreePath, "MERGE_HEAD"))
      throw new Error("Complete the in-progress merge before proposing the squash message");
    if (await this.rebaseInProgress(record.worktreePath))
      throw new Error("Complete the in-progress rebase before proposing the squash message");
    if (!this.awaitingSquashProposals.delete(normalized))
      throw new Error("No worktree landing is waiting for a squash commit message");
    const head = (await this.git(record.worktreePath, "rev-parse", "HEAD")).trim();
    const targetHead = (
      await this.git(record.parentWorktreePath ?? record.projectPath, "rev-parse", "HEAD")
    ).trim();
    this.squashProposals.set(normalized, {
      message: input.body ? `${input.subject}\n\n${input.body}` : input.subject,
      head,
      targetHead,
    });
  }

  private async hasFreshSquashProposal(record: WorktreeRecord): Promise<boolean> {
    const proposal = this.squashProposals.get(resolveNormalized(record.worktreePath));
    if (!proposal) return false;
    const head = (await this.git(record.worktreePath, "rev-parse", "HEAD")).trim();
    if (proposal.head !== head) return false;
    const targetHead = (
      await this.git(record.parentWorktreePath ?? record.projectPath, "rev-parse", "HEAD")
    ).trim();
    return proposal.targetHead === targetHead;
  }

  /**
   * Consumes the recorded proposal unless the worktree or target tip has moved
   * since it was proposed; a stale proposal describes a change that no longer
   * exists and must not be applied.
   */
  private async consumeSquashProposal(
    record: WorktreeRecord,
    targetPath: string,
  ): Promise<string | undefined> {
    const normalized = resolveNormalized(record.worktreePath);
    const proposal = this.squashProposals.get(normalized);
    if (!proposal) return undefined;
    this.squashProposals.delete(normalized);
    const head = (await this.git(record.worktreePath, "rev-parse", "HEAD")).trim();
    const targetHead = (await this.git(targetPath, "rev-parse", "HEAD")).trim();
    if (proposal.head !== head || proposal.targetHead !== targetHead) return undefined;
    return proposal.message;
  }

  /**
   * Creates a worktree branching off the current tip of another managed
   * worktree's branch — used when forking a session into isolated work.
   */
  async createBranchOff(worktreePath: string, worktreeName?: string): Promise<WorktreeRecord> {
    await this.load();
    const source = this.allRecords.find(
      (entry) =>
        (entry.state ?? "active") === "active" &&
        resolveNormalized(entry.worktreePath) === resolveNormalized(worktreePath),
    );
    if (!source) throw new Error("Cake could not find that worktree");
    return this.create(source.projectPath, source.worktreePath, worktreeName);
  }

  async discard(worktreePath: string, keepBranch: boolean): Promise<void> {
    await this.load();
    const normalized = resolveNormalized(worktreePath);
    const record = this.allRecords.find(
      (entry) =>
        ["active", "landed"].includes(entry.state ?? "active") &&
        resolveNormalized(entry.worktreePath) === normalized,
    );
    if (!record) throw new Error("Cake could not find that worktree");
    await this.withRepositoryLock(record.projectPath, () =>
      this.cleanup(record, { keepBranch, state: "discarded" }),
    );
  }

  /** Removes a landed checkout after its sessions have been resolved. */
  async cleanupResolved(worktreePath: string): Promise<void> {
    await this.load();
    const normalized = resolveNormalized(worktreePath);
    const record = this.allRecords.find(
      (entry) => resolveNormalized(entry.worktreePath) === normalized,
    );
    if (!record || !["landed", "discarded", "resolved"].includes(record.state ?? "active")) return;
    if (record.state === "resolved") return;
    await this.withRepositoryLock(record.projectPath, async () => {
      if (record.state === "landed")
        await this.cleanup(record, { keepBranch: false, state: "resolved" });
      else await this.closeRecord(record, "resolved");
    });
  }

  /** Recreates a checkout removed by resolution so an archived session can be restored. */
  async restoreResolved(worktreePath: string): Promise<WorktreeRecord | undefined> {
    await this.load();
    const normalized = resolveNormalized(worktreePath);
    const pendingRecord = this.allRecords.find(
      (entry) => resolveNormalized(entry.worktreePath) === normalized,
    );
    if (!pendingRecord) return undefined;
    if (pendingRecord.parentWorktreePath && !existsSync(pendingRecord.parentWorktreePath))
      await this.restoreResolved(pendingRecord.parentWorktreePath);
    return this.withRepositoryLock(pendingRecord.projectPath, async () => {
      const record = this.allRecords.find(
        (entry) =>
          entry.state === "resolved" && resolveNormalized(entry.worktreePath) === normalized,
      );
      if (!record) return undefined;
      if (!existsSync(record.worktreePath)) {
        const targetPath = record.parentWorktreePath ?? record.projectPath;
        if (!existsSync(targetPath))
          throw new Error("The worktree restore target no longer exists");
        await mkdir(dirname(record.worktreePath), { recursive: true });
        const branchExists = await this.revParseExists(
          record.projectPath,
          `refs/heads/${record.branch}`,
        );
        await this.git(
          record.projectPath,
          "worktree",
          "add",
          ...(branchExists ? [] : ["-b", record.branch]),
          record.worktreePath,
          branchExists ? record.branch : record.baseBranch,
        );
      }
      const restored = { ...record, state: "active" as const };
      const index = this.allRecords.indexOf(record);
      if (index >= 0) this.allRecords = this.allRecords.with(index, restored);
      await this.persist();
      return restored;
    });
  }

  private async availableWorktreeName(
    repositoryRoot: string,
    worktreesDirectory: string,
    requestedName: string,
  ): Promise<string> {
    const namePrefix = requestedName.slice(0, 56).replace(/-+$/g, "") || "worktree";
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const name = `${namePrefix}-${randomUUID().slice(0, 6)}`;
      const branchExists = await this.revParseExists(repositoryRoot, `refs/heads/agent/${name}`);
      if (!branchExists && !existsSync(join(worktreesDirectory, name))) return name;
    }
    throw new Error("Cake could not generate a unique worktree name");
  }

  private landingState(
    record: WorktreeRecord,
  ):
    | { state: "running"; operationId: string }
    | { state: "queued"; operationId: string; position: number }
    | undefined {
    const queue = this.repositoryLandingQueues.get(record.projectPath);
    if (!queue) return undefined;
    const normalized = resolveNormalized(record.worktreePath);
    if (queue.active?.worktreePath === normalized)
      return { state: "running", operationId: queue.active.operationId };
    const index = queue.pending.findIndex((entry) => entry.worktreePath === normalized);
    const entry = queue.pending[index];
    return entry
      ? { state: "queued", operationId: entry.operationId, position: index + 1 }
      : undefined;
  }

  private async acquireLanding(
    record: WorktreeRecord,
    operationId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const repositoryKey = record.projectPath;
    const normalized = resolveNormalized(record.worktreePath);
    let queue = this.repositoryLandingQueues.get(repositoryKey);
    if (!queue) {
      queue = { pending: [] };
      this.repositoryLandingQueues.set(repositoryKey, queue);
    }
    if (queue.active?.operationId === operationId) return;
    if (!queue.active) {
      queue.active = {
        operationId,
        worktreePath: normalized,
        resolve: () => undefined,
        reject: () => undefined,
        signal,
      };
      return;
    }
    if (signal?.aborted) throw new Error("Worktree landing was canceled.");
    await new Promise<void>((resolve, reject) => {
      const entry: LandingQueueEntry = {
        operationId,
        worktreePath: normalized,
        resolve,
        reject,
        signal,
      };
      if (signal) {
        const onAbort = () => {
          const index = queue.pending.indexOf(entry);
          if (index >= 0) queue.pending.splice(index, 1);
          reject(new Error("Worktree landing was canceled."));
        };
        signal.addEventListener("abort", onAbort, { once: true });
        entry.abort = () => signal.removeEventListener("abort", onAbort);
      }
      queue.pending.push(entry);
    });
  }

  private releaseLanding(record: WorktreeRecord, operationId: string) {
    const repositoryKey = record.projectPath;
    const queue = this.repositoryLandingQueues.get(repositoryKey);
    if (!queue || queue.active?.operationId !== operationId) return;
    queue.active.abort?.();
    const next = queue.pending.shift();
    queue.active = next;
    if (next) {
      next.abort?.();
      next.resolve();
    } else this.repositoryLandingQueues.delete(repositoryKey);
  }

  private async withRepositoryLock<T>(
    projectPath: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const prior = this.repositoryOperationTails.get(projectPath) ?? Promise.resolve();
    let release!: () => void;
    const slot = new Promise<void>((releaseResolve) => {
      release = releaseResolve;
    });
    const tail = prior.catch(() => undefined).then(() => slot);
    this.repositoryOperationTails.set(projectPath, tail);
    await prior.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.repositoryOperationTails.get(projectPath) === tail)
        this.repositoryOperationTails.delete(projectPath);
    }
  }

  private async squashMergeAndMarkLanded(record: WorktreeRecord, message: string): Promise<string> {
    const targetPath = record.parentWorktreePath ?? record.projectPath;
    try {
      await this.git(targetPath, "merge", "--squash", record.branch);
      await this.git(targetPath, "commit", "-m", message);
    } catch (error) {
      // Never leave the user's checkout conflicted or half-staged by a failed squash.
      await this.git(targetPath, "reset", "--merge").catch(() => undefined);
      throw error;
    }
    const commit = (await this.git(targetPath, "rev-parse", "HEAD")).trim();
    await this.closeRecord(record, "landed");
    return commit;
  }

  private async cleanup(
    record: WorktreeRecord,
    options: { keepBranch: boolean; state: "discarded" | "resolved" },
  ) {
    const normalized = resolveNormalized(record.worktreePath);
    this.awaitingSquashProposals.delete(normalized);
    this.squashProposals.delete(normalized);
    if (existsSync(record.worktreePath)) {
      try {
        await this.git(record.projectPath, "worktree", "remove", "--force", record.worktreePath);
      } catch {
        // The directory may already be gone; pruning below reconciles Git state either way.
      }
    }
    await this.git(record.projectPath, "worktree", "prune").catch(() => undefined);
    if (!options.keepBranch)
      await this.git(record.projectPath, "branch", "-D", record.branch).catch(() => undefined);
    await this.closeRecord(record, options.state);
  }

  /** Records the strategy of a landing paused for the session agent so it survives a reload. */
  private async rememberPendingLanding(
    record: WorktreeRecord,
    strategy: WorktreeLandRequest["strategy"],
  ) {
    if (record.pendingStrategy === strategy) return;
    const index = this.allRecords.indexOf(record);
    if (index < 0) return;
    this.allRecords = this.allRecords.with(index, { ...record, pendingStrategy: strategy });
    await this.persist();
  }

  private async closeRecord(
    record: WorktreeRecord,
    state: "landed" | "resolved" | "discarded" | "missing",
  ) {
    const index = this.allRecords.indexOf(record);
    if (index >= 0) {
      const closed: WorktreeRecord = { ...record, state };
      Reflect.deleteProperty(closed, "pendingStrategy");
      this.allRecords = this.allRecords.with(index, closed);
    }
    await this.persist();
  }

  private async persist() {
    await this.storage.save(this.allRecords);
  }

  private async load() {
    if (this.loaded) return;
    this.loaded = true;
    this.allRecords = [...(await this.storage.load())];
  }

  private async git(cwd: string, ...args: string[]): Promise<string> {
    return this.gitRunner(cwd, args.flat());
  }

  private async gitWithFallback(cwd: string, args: string[]): Promise<string | undefined> {
    try {
      return (await this.git(cwd, ...args)).trim();
    } catch {
      return undefined;
    }
  }

  private async repositoryRoot(path: string): Promise<string> {
    try {
      return (await this.git(path, "rev-parse", "--show-toplevel")).trim();
    } catch {
      throw new Error("Worktrees require a Git repository");
    }
  }

  /** Returns conflicting file names from a dry-run merge, or null when Git cannot predict it. */
  private async dryRunConflicts(
    repoRoot: string,
    baseBranch: string,
    branch: string,
  ): Promise<string[] | null> {
    try {
      await this.git(repoRoot, "merge-tree", "--write-tree", "--name-only", baseBranch, branch);
      return [];
    } catch (error) {
      const stdout = error instanceof Error && "stdout" in error ? String(error.stdout) : "";
      if (!stdout) return null;
      const lines = stdout
        .split("\n")
        .slice(1)
        .map((line) => line.trim())
        .filter(Boolean);
      return lines;
    }
  }

  /** Returns files with unresolved merge conflicts from the index. */
  private async unmergedFiles(cwd: string): Promise<string[]> {
    const output = await this.git(cwd, "diff", "--name-only", "--diff-filter=U");
    return output
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  }

  private async rebaseInProgress(cwd: string): Promise<boolean> {
    for (const marker of ["rebase-merge", "rebase-apply"]) {
      const gitPath = (
        await this.gitWithFallback(cwd, ["rev-parse", "--git-path", marker])
      )?.trim();
      if (gitPath && existsSync(resolve(cwd, gitPath))) return true;
    }
    return false;
  }

  private async revParseExists(cwd: string, ref: string): Promise<boolean> {
    try {
      await this.git(cwd, "rev-parse", "--verify", "-q", ref);
      return true;
    } catch {
      return false;
    }
  }

  private async revListCount(cwd: string, range: string): Promise<number> {
    const output = await this.git(cwd, "rev-list", "--count", range);
    return Number.parseInt(output.trim(), 10) || 0;
  }

  private async isAncestor(cwd: string, ancestor: string, descendant: string): Promise<boolean> {
    try {
      await this.git(cwd, "merge-base", "--is-ancestor", ancestor, descendant);
      return true;
    } catch {
      return false;
    }
  }

  private async dirtyFileCount(cwd: string): Promise<number> {
    const output = await this.git(cwd, "status", "--porcelain");
    return output.split("\n").filter((line) => line.trim().length > 0).length;
  }

  private async defaultBranch(repoRoot: string): Promise<string> {
    const remoteHead = await this.gitWithFallback(repoRoot, [
      "symbolic-ref",
      "-q",
      "--short",
      "refs/remotes/origin/HEAD",
    ]);
    if (remoteHead) return remoteHead.replace(/^origin\//, "") || "main";
    const current = await this.gitWithFallback(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
    return current && current !== "HEAD" ? current : "main";
  }
}

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9-_]+/g, "-")
      .replace(/^-+|-+$/g, "") || "worktree"
  );
}

function resolveNormalized(path: string): string {
  return path.replace(/\/+$/, "");
}
