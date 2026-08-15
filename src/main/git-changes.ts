import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { ChangedFile } from "../ipc/session-contract";

const execFileAsync = promisify(execFile);
const maxStatusBuffer = 4_000_000;
const maxDiffBuffer = 2_000_000;
const maxDiffLength = 262_144;

interface ChangeEntry {
  path: string;
  previousPath?: string;
  changeCode?: string;
}

export interface WorkspaceCheckpoint {
  tree: string;
  ref: string;
}

export class NotGitRepositoryError extends Error {
  constructor(readonly workspacePath: string) {
    super(`The workspace is not in a Git repository: ${workspacePath}`);
    this.name = "NotGitRepositoryError";
  }
}

/** Captures the complete non-ignored workspace state without mutating Git's real index. */
export async function captureWorkspaceCheckpoint(workspacePath: string, sessionId: string): Promise<WorkspaceCheckpoint> {
  const { root, prefix } = await resolveRepository(workspacePath);
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "cake-git-checkpoint-"));
  const indexPath = join(temporaryDirectory, "index");
  const environment = { ...process.env, GIT_INDEX_FILE: indexPath };
  try {
    if (await hasHead(root)) await git(root, ["read-tree", "HEAD"], maxStatusBuffer, environment);
    else await git(root, ["read-tree", "--empty"], maxStatusBuffer, environment);
    await git(root, ["add", "-A", "--", prefix || "."], maxStatusBuffer, environment);
    const tree = (await git(root, ["write-tree"], maxStatusBuffer, environment)).trim();
    const sessionKey = createHash("sha256").update(sessionId).digest("hex").slice(0, 32);
    const ref = `refs/cake/checkpoints/${sessionKey}/${tree}`;
    await git(root, ["update-ref", ref, tree], maxStatusBuffer);
    return { tree, ref };
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

/** Compares two immutable session checkpoints. The current working tree is not consulted. */
export async function collectCheckpointChanges(workspacePath: string, initialTree: string, latestTree: string): Promise<ChangedFile[]> {
  const { root, prefix } = await resolveRepository(workspacePath);
  await git(root, ["cat-file", "-e", `${initialTree}^{tree}`], maxStatusBuffer);
  await git(root, ["cat-file", "-e", `${latestTree}^{tree}`], maxStatusBuffer);
  const pathspec = prefix || ".";
  const changed = await git(root, ["diff", "--name-status", "-z", "--find-renames", "--find-copies", initialTree, latestTree, "--", pathspec], maxStatusBuffer);
  const entries = parseNameStatus(changed).filter((entry) => withinWorkspace(entry.path, prefix));
  const files: ChangedFile[] = [];
  for (const entry of entries) {
    const paths = entry.previousPath ? [entry.previousPath, entry.path] : [entry.path];
    const diff = await git(root, ["diff", "--no-ext-diff", "--find-renames", "--find-copies", initialTree, latestTree, "--", ...paths], maxDiffBuffer);
    const lines = diff.split("\n");
    files.push({
      path: fromRepositoryPath(entry.path, prefix),
      previousPath: entry.previousPath && withinWorkspace(entry.previousPath, prefix) ? fromRepositoryPath(entry.previousPath, prefix) : undefined,
      status: changeStatus(entry),
      additions: lines.filter((line) => line.startsWith("+") && !line.startsWith("+++")).length,
      deletions: lines.filter((line) => line.startsWith("-") && !line.startsWith("---")).length,
      diff: diff.slice(0, maxDiffLength)
    });
  }
  return files;
}

async function resolveRepository(workspacePath: string) {
  const canonicalWorkspace = await realpath(resolve(workspacePath));
  let repositoryRoot: string;
  try {
    repositoryRoot = (await git(canonicalWorkspace, ["rev-parse", "--show-toplevel"], maxStatusBuffer)).trim();
  } catch (error) {
    if (isNotGitRepositoryFailure(error)) throw new NotGitRepositoryError(canonicalWorkspace);
    throw error;
  }
  const root = await realpath(repositoryRoot);
  const prefix = relative(root, canonicalWorkspace);
  if (prefix === ".." || prefix.startsWith(`..${sep}`)) throw new Error("The workspace is outside its Git repository");
  return { root, prefix };
}

function isNotGitRepositoryFailure(error: unknown) {
  if (!error || typeof error !== "object" || !("stderr" in error)) return false;
  return String(error.stderr).toLowerCase().includes("not a git repository");
}

export function parseNameStatus(output: string): ChangeEntry[] {
  const records = output.split("\0");
  const entries: ChangeEntry[] = [];
  for (let index = 0; index < records.length;) {
    const status = records[index++];
    if (!status) continue;
    const changeCode = status[0]!;
    if (changeCode === "R" || changeCode === "C") {
      const previousPath = records[index++];
      const path = records[index++];
      if (previousPath !== undefined && path !== undefined) entries.push({ path, previousPath, changeCode });
      continue;
    }
    const path = records[index++];
    if (path !== undefined) entries.push({ path, changeCode });
  }
  return entries;
}

async function hasHead(root: string) {
  try {
    await git(root, ["rev-parse", "--verify", "HEAD"], maxStatusBuffer);
    return true;
  } catch {
    return false;
  }
}

async function git(cwd: string, args: string[], maxBuffer: number, env?: NodeJS.ProcessEnv) {
  return (await execFileAsync("git", args, { cwd, maxBuffer, env })).stdout;
}

function withinWorkspace(path: string, prefix: string) {
  return !prefix || path === prefix || path.startsWith(`${prefix}/`);
}

function fromRepositoryPath(path: string, prefix: string) {
  return prefix ? path.slice(prefix.length + 1) : path;
}

function changeStatus(entry: ChangeEntry): ChangedFile["status"] {
  if (entry.previousPath) return entry.changeCode === "C" ? "copied" : "renamed";
  if (entry.changeCode === "D") return "deleted";
  if (entry.changeCode === "A") return "added";
  return "modified";
}
