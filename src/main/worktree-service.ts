import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { AtomicFileWriter } from "./atomic-file-writer";
import {
  worktreeRecordSchema,
  worktreeStatusSchema,
  type WorktreeLandOutcome,
  type WorktreeLandRequest,
  type WorktreeLandingCoordinator,
  type WorktreeRecord,
  type WorktreeStatus,
} from "../ipc/worktree-contract";

const execFileAsync = promisify(execFile);
const maxBuffer = 4_000_000;

const storageSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  records: z.array(worktreeRecordSchema).max(500).default([]),
});

interface LandOptions {
  request: WorktreeLandRequest;
}

/**
 * Creates, inspects, lands, and cleans up Cake-managed Git worktrees.
 *
 * Each record is one isolated checkout in a sibling directory of its
 * repository, paired with an `agent/`-namespaced branch. Cake owns the whole
 * lifecycle. Landing either replays the branch commits onto the target branch
 * or squashes them into one commit; conflict resolution and squash-message
 * proposals are delegated to the worktree's session agent through the Cake
 * gateway, and landing is retried once the agent finishes.
 */
export class WorktreeService implements WorktreeLandingCoordinator {
  private readonly writer = new AtomicFileWriter();
  private allRecords: WorktreeRecord[] = [];
  private loaded = false;
  private readonly repositoryOperationTails = new Map<string, Promise<void>>();
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
  private readonly storagePath: string;

  constructor(storagePath: string) {
    this.storagePath = storagePath;
  }

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
  ): Promise<WorktreeRecord> {
    await this.load();
    const root = await realpath(await repositoryRoot(projectPath));
    return this.withRepositoryLock(root, () =>
      this.createRecord(root, baseWorktreePath, worktreeName),
    );
  }

  private async createRecord(
    root: string,
    baseWorktreePath?: string,
    worktreeName?: string,
  ): Promise<WorktreeRecord> {
    const parent = baseWorktreePath
      ? this.allRecords.find(
          (entry) =>
            (entry.state ?? "active") === "active" &&
            resolveNormalized(entry.worktreePath) === resolveNormalized(baseWorktreePath),
        )
      : undefined;
    if (baseWorktreePath && (!parent || parent.projectPath !== root))
      throw new Error("Cake could not find that base worktree");
    if (parent && !existsSync(parent.worktreePath))
      throw new Error("The base worktree no longer exists");
    if (parent && (await dirtyFileCount(parent.worktreePath)) > 0)
      throw new Error("Commit the base worktree before creating a child worktree.");

    const baseBranch = parent?.branch ?? (await defaultBranch(root));
    const startPoint = parent?.branch ?? baseBranch;
    const baseCommit = (await git(root, "rev-parse", startPoint)).trim();
    const slug = slugify(basename(root));
    const id = `${Date.now().toString(36)}${Math.random().toString(16).slice(2, 6)}`;
    const name = worktreeName ?? `${slug}-${id}`;
    if (worktreeName && !/^[a-z0-9][a-z0-9-]{0,62}$/.test(name))
      throw new Error("Invalid worktree name");
    const branch = `agent/${name}`;
    const worktreesDir = join(dirname(root), `.${slug}-worktrees`);
    const worktreePath = join(worktreesDir, name);
    await mkdir(worktreesDir, { recursive: true });
    await git(root, "worktree", "add", "-b", branch, worktreePath, baseCommit);
    const record: WorktreeRecord = {
      projectPath: root,
      worktreePath,
      branch,
      baseBranch,
      parentWorktreePath: parent?.worktreePath,
      baseCommit,
      state: "active",
      createdAt: new Date().toISOString(),
    };
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
    if (!record || (record.state ?? "active") !== "active") return undefined;
    if (!existsSync(record.worktreePath)) {
      // Preserve the historical checkout association so its transcripts remain discoverable.
      await git(record.projectPath, "worktree", "prune").catch(() => undefined);
      await this.closeRecord(record, "missing");
      return undefined;
    }
    const targetPath = record.parentWorktreePath ?? record.projectPath;
    if (!existsSync(targetPath)) throw new Error("The worktree landing target no longer exists");
    const [dirtyCount, aheadCount, merged, targetDirty, targetBranch, merging, rebasing] =
      await Promise.all([
        dirtyFileCount(record.worktreePath),
        revListCount(record.worktreePath, `${record.baseBranch}..HEAD`),
        isAncestor(record.worktreePath, "HEAD", record.baseBranch),
        dirtyFileCount(targetPath).then((count) => count > 0),
        gitWithFallback(targetPath, ["rev-parse", "--abbrev-ref", "HEAD"]),
        revParseExists(record.worktreePath, "MERGE_HEAD"),
        rebaseInProgress(record.worktreePath),
      ]);
    return worktreeStatusSchema.parse({
      record,
      targetBranch: record.baseBranch,
      dirtyCount,
      aheadCount,
      merged,
      targetDirty,
      targetOnBranch: targetBranch === record.baseBranch,
      merging,
      rebasing,
      squashMessageReady: await this.hasFreshSquashProposal(record),
    });
  }

  /**
   * Lands the worktree branch into its base branch and removes the worktree.
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
    return this.withRepositoryLock(record.projectPath, () => this.landRecord(record, options));
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
      (await rebaseInProgress(record.worktreePath)) ||
      (await revParseExists(record.worktreePath, "MERGE_HEAD"))
    ) {
      await this.rememberPendingLanding(record, options.request.strategy);
      return { outcome: "resolving", files: await unmergedFiles(record.worktreePath) };
    }
    if ((await dirtyFileCount(record.worktreePath)) > 0)
      throw new Error("The worktree has uncommitted changes. Commit or discard them first.");
    const targetPath = record.parentWorktreePath ?? record.projectPath;
    if (!existsSync(targetPath)) throw new Error("The worktree landing target no longer exists");
    if ((await git(targetPath, "rev-parse", "--abbrev-ref", "HEAD")).trim() !== record.baseBranch)
      throw new Error(`Switch the landing target back to "${record.baseBranch}" first.`);
    if ((await dirtyFileCount(targetPath)) > 0)
      throw new Error("The landing target has uncommitted changes. Commit or stash them first.");
    const activeChildren = this.allRecords.filter(
      (entry) =>
        (entry.state ?? "active") === "active" &&
        entry.parentWorktreePath === record.worktreePath &&
        existsSync(entry.worktreePath),
    );
    if (activeChildren.length > 0)
      throw new Error("Land or discard this worktree's active child worktrees first.");

    const aheadCount = await revListCount(record.worktreePath, `${record.baseBranch}..HEAD`);
    if (aheadCount === 0) {
      await this.cleanup(record, { keepBranch: false, state: "landed" });
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
        await git(targetPath, "merge", "--ff-only", record.branch);
        const commit = (await git(targetPath, "rev-parse", "HEAD")).trim();
        await this.cleanup(record, { keepBranch: false, state: "landed" });
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
      const head = (await git(record.worktreePath, "rev-parse", "HEAD")).trim();
      const targetHead = (await git(targetPath, "rev-parse", "HEAD")).trim();
      this.squashProposals.set(normalized, { message, head, targetHead });
    }
    // Gate every target mutation on a fresh conflict prediction so a stale
    // proposal or a moved target can never leave the target checkout conflicted.
    const conflictedFiles = await dryRunConflicts(targetPath, record.baseBranch, record.branch);
    if (conflictedFiles === null || conflictedFiles.length > 0) {
      // Resolve the combined result once: merge the target into the worktree so
      // the agent resolves every conflict a squash would hit in one pass.
      try {
        await git(record.worktreePath, "merge", "--no-ff", "--no-edit", record.baseBranch);
      } catch {
        // A non-zero exit with MERGE_HEAD present is the expected conflict path.
      }
      if (await revParseExists(record.worktreePath, "MERGE_HEAD")) {
        this.awaitingSquashProposals.add(normalized);
        return {
          outcome: "resolving",
          files: conflictedFiles ?? (await unmergedFiles(record.worktreePath)),
        };
      }
    }
    const requested = await this.consumeSquashProposal(record, targetPath);
    if (!requested) {
      this.awaitingSquashProposals.add(normalized);
      return { outcome: "proposal" };
    }
    const commit = await this.squashMergeAndCleanup(record, requested);
    return { outcome: "landed", commit };
  }

  /** Returns unmerged files when the rebase stops on conflicts, or null when it completed. */
  private async rebaseOntoTarget(record: WorktreeRecord): Promise<string[] | null> {
    try {
      await git(record.worktreePath, "rebase", record.baseBranch);
      return null;
    } catch (error) {
      if (await rebaseInProgress(record.worktreePath)) return unmergedFiles(record.worktreePath);
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
    if (await revParseExists(record.worktreePath, "MERGE_HEAD"))
      throw new Error("Complete the in-progress merge before proposing the squash message");
    if (await rebaseInProgress(record.worktreePath))
      throw new Error("Complete the in-progress rebase before proposing the squash message");
    if (!this.awaitingSquashProposals.delete(normalized))
      throw new Error("No worktree landing is waiting for a squash commit message");
    const head = (await git(record.worktreePath, "rev-parse", "HEAD")).trim();
    const targetHead = (
      await git(record.parentWorktreePath ?? record.projectPath, "rev-parse", "HEAD")
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
    const head = (await git(record.worktreePath, "rev-parse", "HEAD")).trim();
    if (proposal.head !== head) return false;
    const targetHead = (
      await git(record.parentWorktreePath ?? record.projectPath, "rev-parse", "HEAD")
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
    const head = (await git(record.worktreePath, "rev-parse", "HEAD")).trim();
    const targetHead = (await git(targetPath, "rev-parse", "HEAD")).trim();
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
        (entry.state ?? "active") === "active" &&
        resolveNormalized(entry.worktreePath) === normalized,
    );
    if (!record) throw new Error("Cake could not find that worktree");
    await this.withRepositoryLock(record.projectPath, () =>
      this.cleanup(record, { keepBranch, state: "discarded" }),
    );
  }

  private async withRepositoryLock<T>(
    projectPath: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const prior = this.repositoryOperationTails.get(projectPath) ?? Promise.resolve();
    let release!: () => void;
    const slot = new Promise<void>((resolve) => {
      release = resolve;
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

  private async squashMergeAndCleanup(record: WorktreeRecord, message: string): Promise<string> {
    const targetPath = record.parentWorktreePath ?? record.projectPath;
    try {
      await git(targetPath, "merge", "--squash", record.branch);
      await git(targetPath, "commit", "-m", message);
    } catch (error) {
      // Never leave the user's checkout conflicted or half-staged by a failed squash.
      await git(targetPath, "reset", "--merge").catch(() => undefined);
      throw error;
    }
    const commit = (await git(targetPath, "rev-parse", "HEAD")).trim();
    await this.cleanup(record, { keepBranch: false, state: "landed" });
    return commit;
  }

  private async cleanup(
    record: WorktreeRecord,
    options: { keepBranch: boolean; state: "landed" | "discarded" },
  ) {
    const normalized = resolveNormalized(record.worktreePath);
    this.awaitingSquashProposals.delete(normalized);
    this.squashProposals.delete(normalized);
    if (existsSync(record.worktreePath)) {
      try {
        await git(record.projectPath, "worktree", "remove", "--force", record.worktreePath);
      } catch {
        // The directory may already be gone; pruning below reconciles Git state either way.
      }
    }
    await git(record.projectPath, "worktree", "prune").catch(() => undefined);
    if (!options.keepBranch)
      await git(record.projectPath, "branch", "-D", record.branch).catch(() => undefined);
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

  private async closeRecord(record: WorktreeRecord, state: "landed" | "discarded" | "missing") {
    const index = this.allRecords.indexOf(record);
    if (index >= 0)
      this.allRecords = this.allRecords.with(index, {
        ...record,
        state,
        pendingStrategy: undefined,
      });
    await this.persist();
  }

  private async persist() {
    const payload = storageSchema.parse({ schemaVersion: 1, records: this.allRecords });
    await this.writer.write(this.storagePath, JSON.stringify(payload, null, 2));
  }

  private async load() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = await readFile(this.storagePath, "utf8");
      this.allRecords = storageSchema.parse(JSON.parse(raw)).records;
    } catch {
      this.allRecords = [];
    }
  }
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args.flat(), { cwd, maxBuffer });
  return stdout;
}

async function gitWithFallback(cwd: string, args: string[]): Promise<string | undefined> {
  try {
    return (await git(cwd, ...args)).trim();
  } catch {
    return undefined;
  }
}

async function repositoryRoot(path: string): Promise<string> {
  try {
    return (await git(path, "rev-parse", "--show-toplevel")).trim();
  } catch {
    throw new Error("Worktrees require a Git repository");
  }
}

/** Returns conflicting file names from a dry-run merge, or null when Git cannot predict it. */
async function dryRunConflicts(
  repoRoot: string,
  baseBranch: string,
  branch: string,
): Promise<string[] | null> {
  try {
    await git(repoRoot, "merge-tree", "--write-tree", "--name-only", baseBranch, branch);
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
async function unmergedFiles(cwd: string): Promise<string[]> {
  const output = await git(cwd, "diff", "--name-only", "--diff-filter=U");
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

async function rebaseInProgress(cwd: string): Promise<boolean> {
  for (const marker of ["rebase-merge", "rebase-apply"]) {
    const gitPath = (await gitWithFallback(cwd, ["rev-parse", "--git-path", marker]))?.trim();
    if (gitPath && existsSync(resolve(cwd, gitPath))) return true;
  }
  return false;
}

async function revParseExists(cwd: string, ref: string): Promise<boolean> {
  try {
    await git(cwd, "rev-parse", "--verify", "-q", ref);
    return true;
  } catch {
    return false;
  }
}

async function revListCount(cwd: string, range: string): Promise<number> {
  const output = await git(cwd, "rev-list", "--count", range);
  return Number.parseInt(output.trim(), 10) || 0;
}

async function isAncestor(cwd: string, ancestor: string, descendant: string): Promise<boolean> {
  try {
    await git(cwd, "merge-base", "--is-ancestor", ancestor, descendant);
    return true;
  } catch {
    return false;
  }
}

async function dirtyFileCount(cwd: string): Promise<number> {
  const output = await git(cwd, "status", "--porcelain");
  return output.split("\n").filter((line) => line.trim().length > 0).length;
}

async function defaultBranch(repoRoot: string): Promise<string> {
  const remoteHead = await gitWithFallback(repoRoot, [
    "symbolic-ref",
    "-q",
    "--short",
    "refs/remotes/origin/HEAD",
  ]);
  if (remoteHead) return remoteHead.replace(/^origin\//, "") || "main";
  const current = await gitWithFallback(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return current && current !== "HEAD" ? current : "main";
}

function slugify(value: string): string {
  return value.replace(/[^a-zA-Z0-9-_]+/g, "-").replace(/^-+|-+$/g, "") || "worktree";
}

function resolveNormalized(path: string): string {
  return path.replace(/\/+$/, "");
}
