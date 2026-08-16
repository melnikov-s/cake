import { SessionManager, getPackageDir, hasTrustRequiringProjectResources } from "@earendil-works/pi-coding-agent";
import { CombinedAutocompleteProvider } from "@earendil-works/pi-tui";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { SESSION_TITLE_MAX_LENGTH, type FileSuggestion, type SessionPreview, type SessionSummary } from "../ipc/session-contract";
import { projectSessionEntries } from "./session-projection";

export function loadPiChangelog() {
  try {
    return readFileSync(join(getPackageDir(), "CHANGELOG.md"), "utf8");
  } catch {
    return "# Changelog\n\nNo changelog entries found.";
  }
}

/** Resolve the Cake source tree that matches the running authoring skill. */
export function cakePluginAuthoringSkillPath(authoringRoot = process.env.CAKE_AUTHORING_ROOT ?? resolve(import.meta.dirname, "../..")) {
  return join(authoringRoot, ".agents", "skills", "cake-plugin-authoring");
}

export function inspectWorkspace(path: string) {
  return { path, trustRequired: hasTrustRequiringProjectResources(path) };
}

/** Mirror Pi's documented per-workspace directory layout beneath Cake's session root. */
export function cakeWorkspaceSessionDirectory(cwd: string, sessionRoot: string) {
  const resolvedCwd = resolve(cwd);
  const safePath = `--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return join(resolve(sessionRoot), safePath);
}

export async function suggestProjectFiles(options: { cwd: string; prefix: string; agentDir: string; fdPath?: string }): Promise<FileSuggestion[]> {
  const installedFd = join(options.agentDir, "bin", process.platform === "win32" ? "fd.exe" : "fd");
  const provider = new CombinedAutocompleteProvider([], options.cwd, options.fdPath ?? (existsSync(installedFd) ? installedFd : "fd"));
  const text = `@${options.prefix}`;
  const suggestions = await provider.getSuggestions([text], 0, text.length, { signal: AbortSignal.timeout(5_000) });
  return (suggestions?.items ?? []).slice(0, 20).map(({ value, label, description }) => ({ value, label, description }));
}

export async function listWorkspaceSessions(cwd: string, sessionDir: string, direct = false): Promise<SessionSummary[]> {
  const sessions = await SessionManager.list(cwd, direct ? resolve(sessionDir) : cakeWorkspaceSessionDirectory(cwd, sessionDir));
  const idsByPath = new Map(sessions.map((item) => [item.path, item.id]));
  return sessions.map((item) => ({
    id: item.id,
    title: (item.name || item.firstMessage || "New chat").slice(0, SESSION_TITLE_MAX_LENGTH),
    created: item.created.toISOString(),
    modified: item.modified.toISOString(),
    messageCount: item.messageCount,
    parentSessionId: item.parentSessionPath ? idsByPath.get(item.parentSessionPath) : undefined,
    archived: false
  }));
}

export async function loadWorkspaceSessionPreview(cwd: string, sessionId: string, sessionDir: string): Promise<SessionPreview | undefined> {
  const workspaceSessionDir = cakeWorkspaceSessionDirectory(cwd, sessionDir);
  const sessions = await SessionManager.list(cwd, workspaceSessionDir);
  const target = sessions.find((session) => session.id === sessionId);
  if (!target) return undefined;
  const manager = SessionManager.open(target.path, workspaceSessionDir, cwd);
  return {
    workspacePath: cwd,
    sessionId,
    sessionFile: target.path,
    parts: projectSessionEntries(manager.getBranch())
  };
}
