import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { AtomicFileWriter } from "./atomic-file-writer";
import {
  worktreeRecordSchema,
  worktreeStatusSchema,
  type WorktreeLandOutcome,
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
  message?: string;
  autoResolve: boolean;
}

/**
 * Creates, inspects, lands, and cleans up Cake-managed Git worktrees.
 *
 * Each record is one isolated checkout in a sibling directory of its
 * repository, paired with an `agent/`-namespaced branch. Cake owns the whole
 * lifecycle; the only user-visible decision is landing versus discarding.
 */
export class WorktreeService {
  private readonly writer = new AtomicFileWriter();
  private allRecords: WorktreeRecord[] = [];
  private loaded = false;
  private readonly repositoryOperationTails = new Map<string, Promise<void>>();
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
  async create(projectPath: string, baseWorktreePath?: string): Promise<WorktreeRecord> {
    await this.load();
    const root = await realpath(await repositoryRoot(projectPath));
    return this.withRepositoryLock(root, () => this.createRecord(root, baseWorktreePath));
  }

  private async createRecord(root: string, baseWorktreePath?: string): Promise<WorktreeRecord> {
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
    const branch = `agent/${slug}-${id}`;
    const worktreesDir = join(dirname(root), `.${slug}-worktrees`);
    const worktreePath = join(worktreesDir, `${slug}-${id}`);
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
    const [dirtyCount, aheadCount, merged, targetDirty, targetBranch] = await Promise.all([
      dirtyFileCount(record.worktreePath),
      revListCount(record.worktreePath, `${record.baseBranch}..HEAD`),
      isAncestor(record.worktreePath, "HEAD", record.baseBranch),
      dirtyFileCount(targetPath).then((count) => count > 0),
      gitWithFallback(targetPath, ["rev-parse", "--abbrev-ref", "HEAD"]),
    ]);
    return worktreeStatusSchema.parse({
      record,
      targetBranch: record.baseBranch,
      dirtyCount,
      aheadCount,
      merged,
      targetDirty,
      targetOnBranch: targetBranch === record.baseBranch,
      merging: await revParseExists(record.worktreePath, "MERGE_HEAD"),
    });
  }

  /**
   * Merges the worktree branch back into its base branch as one squash commit
   * and removes the worktree. When conflicts block the deterministic merge and
   * `autoResolve` is set, a conflicted merge is started inside the worktree so
   * the session agent can resolve it; landing is retried afterwards.
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

    const conflictedFiles = await dryRunConflicts(targetPath, record.baseBranch, record.branch);
    if (conflictedFiles === null || conflictedFiles.length > 0) {
      if (!options.autoResolve) return { outcome: "conflicts", files: conflictedFiles ?? [] };
      try {
        await git(record.worktreePath, "merge", "--no-ff", "--no-edit", record.baseBranch);
      } catch {
        // A non-zero exit with MERGE_HEAD present is the expected conflict path.
      }
      if (!(await revParseExists(record.worktreePath, "MERGE_HEAD"))) {
        const commit = await this.mergeAndCleanup(record, options.message);
        return { outcome: "landed", commit };
      }
      return { outcome: "resolving", files: conflictedFiles ?? [] };
    }

    const commit = await this.mergeAndCleanup(record, options.message);
    return { outcome: "landed", commit };
  }

  /**
   * Creates a worktree branching off the current tip of another managed
   * worktree's branch — used when forking a session into isolated work.
   */
  async createBranchOff(worktreePath: string): Promise<WorktreeRecord> {
    await this.load();
    const source = this.allRecords.find(
      (entry) =>
        (entry.state ?? "active") === "active" &&
        resolveNormalized(entry.worktreePath) === resolveNormalized(worktreePath),
    );
    if (!source) throw new Error("Cake could not find that worktree");
    return this.create(source.projectPath, source.worktreePath);
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

  private async mergeAndCleanup(
    record: WorktreeRecord,
    message?: string,
  ): Promise<string | undefined> {
    const aheadCount = await revListCount(record.worktreePath, `${record.baseBranch}..HEAD`);
    let commit: string | undefined;
    if (aheadCount > 0) {
      const targetPath = record.parentWorktreePath ?? record.projectPath;
      await git(targetPath, "merge", "--squash", record.branch);
      await git(
        targetPath,
        "commit",
        "-m",
        message?.trim() || `Merge worktree branch '${record.branch}'`,
      );
      commit = (
        await git(record.parentWorktreePath ?? record.projectPath, "rev-parse", "HEAD")
      ).trim();
    }
    await this.cleanup(record, { keepBranch: false, state: "landed" });
    return commit;
  }

  private async cleanup(
    record: WorktreeRecord,
    options: { keepBranch: boolean; state: "landed" | "discarded" },
  ) {
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

  private async closeRecord(record: WorktreeRecord, state: "landed" | "discarded" | "missing") {
    const index = this.allRecords.indexOf(record);
    if (index >= 0) this.allRecords = this.allRecords.with(index, { ...record, state });
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
