import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { ChangedFile } from "../ipc/session-contract";

const execFileAsync = promisify(execFile);
const emptyTree = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const maxStatusBuffer = 4_000_000;
const maxDiffBuffer = 2_000_000;
const maxDiffLength = 262_144;

interface StatusEntry {
  path: string;
  previousPath?: string;
  indexStatus: string;
  worktreeStatus: string;
  untracked?: boolean;
}

export async function collectWorkspaceChanges(workspacePath: string): Promise<ChangedFile[]> {
  const canonicalWorkspace = await realpath(resolve(workspacePath));
  const root = await realpath((await git(canonicalWorkspace, ["rev-parse", "--show-toplevel"], maxStatusBuffer)).trim());
  const prefix = relative(root, canonicalWorkspace);
  if (prefix === ".." || prefix.startsWith(`..${sep}`)) throw new Error("The workspace is outside its Git repository");
  const pathspec = prefix || ".";
  const status = await git(root, ["-c", "status.relativePaths=false", "status", "--porcelain=v2", "-z", "--untracked-files=all", "--", pathspec], maxStatusBuffer);
  const entries = parsePorcelainV2(status).filter((entry) => withinWorkspace(entry.path, prefix));
  const baseline = await hasHead(root) ? "HEAD" : emptyTree;
  const files: ChangedFile[] = [];
  for (const entry of entries) {
    const diff = entry.untracked
      ? await untrackedDiff(root, entry.path)
      : await trackedDiff(root, baseline, entry);
    const workspaceRelativePath = fromRepositoryPath(entry.path, prefix);
    const previousPath = entry.previousPath && withinWorkspace(entry.previousPath, prefix)
      ? fromRepositoryPath(entry.previousPath, prefix)
      : undefined;
    const lines = diff.split("\n");
    files.push({
      path: workspaceRelativePath,
      previousPath,
      status: changeStatus(entry),
      staged: entry.indexStatus !== "." && entry.indexStatus !== "?",
      unstaged: entry.worktreeStatus !== "." || Boolean(entry.untracked),
      additions: lines.filter((line) => line.startsWith("+") && !line.startsWith("+++")).length,
      deletions: lines.filter((line) => line.startsWith("-") && !line.startsWith("---")).length,
      diff: diff.slice(0, maxDiffLength)
    });
  }
  return files;
}

export function parsePorcelainV2(output: string): StatusEntry[] {
  const records = output.split("\0");
  const entries: StatusEntry[] = [];
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (!record) continue;
    if (record.startsWith("1 ")) {
      const match = /^1 ([^ ]{2}) (?:[^ ]+ ){6}([\s\S]*)$/.exec(record);
      if (match) entries.push({ path: match[2]!, indexStatus: match[1]![0]!, worktreeStatus: match[1]![1]! });
      continue;
    }
    if (record.startsWith("2 ")) {
      const match = /^2 ([^ ]{2}) (?:[^ ]+ ){7}([\s\S]*)$/.exec(record);
      const previousPath = records[index + 1];
      if (match && previousPath !== undefined) {
        entries.push({ path: match[2]!, previousPath, indexStatus: match[1]![0]!, worktreeStatus: match[1]![1]! });
        index += 1;
      }
      continue;
    }
    if (record.startsWith("u ")) {
      const match = /^u ([^ ]{2}) (?:[^ ]+ ){8}([\s\S]*)$/.exec(record);
      if (match) entries.push({ path: match[2]!, indexStatus: match[1]![0]!, worktreeStatus: match[1]![1]! });
      continue;
    }
    if (record.startsWith("? ")) entries.push({ path: record.slice(2), indexStatus: "?", worktreeStatus: "?", untracked: true });
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

async function trackedDiff(root: string, baseline: string, entry: StatusEntry) {
  const paths = entry.previousPath ? [entry.previousPath, entry.path] : [entry.path];
  return git(root, ["diff", "--no-ext-diff", "--find-renames", "--find-copies", baseline, "--", ...paths], maxDiffBuffer);
}

async function untrackedDiff(root: string, path: string) {
  try {
    return await git(root, ["diff", "--no-index", "--no-ext-diff", "--", "/dev/null", path], maxDiffBuffer);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && Number(error.code) === 1 && "stdout" in error) return String(error.stdout);
    throw error;
  }
}

async function git(cwd: string, args: string[], maxBuffer: number) {
  return (await execFileAsync("git", args, { cwd, maxBuffer })).stdout;
}

function withinWorkspace(path: string, prefix: string) {
  return !prefix || path === prefix || path.startsWith(`${prefix}/`);
}

function fromRepositoryPath(path: string, prefix: string) {
  return prefix ? path.slice(prefix.length + 1) : path;
}

function changeStatus(entry: StatusEntry): ChangedFile["status"] {
  if (entry.untracked) return "untracked";
  if (entry.previousPath) return entry.indexStatus === "C" || entry.worktreeStatus === "C" ? "copied" : "renamed";
  const codes = `${entry.indexStatus}${entry.worktreeStatus}`;
  if (codes.includes("U")) return "conflicted";
  if (codes.includes("D")) return "deleted";
  if (codes.includes("A")) return "added";
  return "modified";
}
