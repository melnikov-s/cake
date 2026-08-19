import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import type { ChangedFile } from "../ipc/session-contract";

const execFileAsync = promisify(execFile);
const maxStatusBuffer = 4_000_000;
const maxDiffBuffer = 2_000_000;
const maxDiffLength = 262_144;

interface ChangeEntry {
  path: string;
  previousPath?: string;
  changeCode?: string;
  untracked?: boolean;
}

export class NotGitRepositoryError extends Error {
  constructor(readonly workspacePath: string) {
    super(`The workspace is not in a Git repository: ${workspacePath}`);
    this.name = "NotGitRepositoryError";
  }
}

/** Reads all staged, unstaged, and untracked changes with ordinary Git diffs. */
export async function collectWorkingTreeChanges(workspacePath: string): Promise<ChangedFile[]> {
  const { root, prefix } = await resolveRepository(workspacePath);
  const base = await repositoryBaseTree(root);
  const pathspec = prefix || ".";
  const [tracked, untracked] = await Promise.all([
    git(
      root,
      ["diff", "--name-status", "-z", "--find-renames", "--find-copies", base, "--", pathspec],
      maxStatusBuffer,
    ),
    git(
      root,
      ["ls-files", "--others", "--exclude-standard", "-z", "--", pathspec],
      maxStatusBuffer,
    ),
  ]);
  const entries = [
    ...parseNameStatus(tracked),
    ...untracked
      .split("\0")
      .filter(Boolean)
      .map((path): ChangeEntry => ({ path, changeCode: "A", untracked: true })),
  ].filter((entry) => withinWorkspace(entry.path, prefix));
  const files: ChangedFile[] = [];
  for (const entry of entries) {
    const paths = entry.previousPath ? [entry.previousPath, entry.path] : [entry.path];
    const diff = entry.untracked
      ? await untrackedDiff(root, entry.path)
      : await git(
          root,
          ["diff", "--no-ext-diff", "--find-renames", "--find-copies", base, "--", ...paths],
          maxDiffBuffer,
        );
    const lines = diff.split("\n");
    files.push({
      path: fromRepositoryPath(entry.path, prefix),
      previousPath:
        entry.previousPath && withinWorkspace(entry.previousPath, prefix)
          ? fromRepositoryPath(entry.previousPath, prefix)
          : undefined,
      status: changeStatus(entry),
      additions: lines.filter((line) => line.startsWith("+") && !line.startsWith("+++")).length,
      deletions: lines.filter((line) => line.startsWith("-") && !line.startsWith("---")).length,
      diff: diff.slice(0, maxDiffLength),
    });
  }
  return files;
}

async function repositoryBaseTree(root: string) {
  if (await hasHead(root)) return "HEAD";
  const nullDevice = process.platform === "win32" ? "NUL" : "/dev/null";
  return (await git(root, ["hash-object", "-t", "tree", nullDevice], maxStatusBuffer)).trim();
}

const noIndexFailureSchema = z.object({
  stdout: z.union([z.string(), z.instanceof(Buffer)]),
  code: z.union([z.number(), z.string()]).optional(),
});

async function untrackedDiff(root: string, path: string) {
  const nullDevice = process.platform === "win32" ? "NUL" : "/dev/null";
  try {
    return await git(
      root,
      ["diff", "--no-index", "--no-ext-diff", "--", nullDevice, path],
      maxDiffBuffer,
    );
  } catch (error) {
    const parsed = noIndexFailureSchema.safeParse(error);
    if (parsed.success && parsed.data.code === 1) return String(parsed.data.stdout);
    throw error;
  }
}

async function resolveRepository(workspacePath: string) {
  const canonicalWorkspace = await realpath(resolve(workspacePath));
  let repositoryRoot: string;
  try {
    repositoryRoot = (
      await git(canonicalWorkspace, ["rev-parse", "--show-toplevel"], maxStatusBuffer)
    ).trim();
  } catch (error) {
    if (isNotGitRepositoryFailure(error)) throw new NotGitRepositoryError(canonicalWorkspace);
    throw error;
  }
  const root = await realpath(repositoryRoot);
  const prefix = relative(root, canonicalWorkspace);
  if (prefix === ".." || prefix.startsWith(`..${sep}`))
    throw new Error("The workspace is outside its Git repository");
  return { root, prefix };
}

interface GitCommandFailure {
  stderr: string | Buffer;
}

function isNotGitRepositoryFailure(error: unknown): error is GitCommandFailure {
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
      if (previousPath !== undefined && path !== undefined)
        entries.push({ path, previousPath, changeCode });
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
