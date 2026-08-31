import {
  SessionManager,
  getPackageDir,
  hasTrustRequiringProjectResources,
} from "@earendil-works/pi-coding-agent";
import { CombinedAutocompleteProvider } from "@earendil-works/pi-tui";
import { existsSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import {
  SESSION_TITLE_MAX_LENGTH,
  type FileSuggestion,
  type SessionPreview,
  type SessionSummary,
} from "../../../ipc/session-contract";
import { projectSessionEntries } from "./session-projection";

export function loadPiChangelog() {
  try {
    return readFileSync(join(getPackageDir(), "CHANGELOG.md"), "utf8");
  } catch {
    return "# Changelog\n\nNo changelog entries found.";
  }
}

/** Resolve the Cake source tree that matches the running authoring skill. */
export function cakePluginAuthoringSkillPath(
  authoringRoot = process.env.CAKE_AUTHORING_ROOT ?? resolve(import.meta.dirname, "../.."),
) {
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

export function forkWorkspaceSession(sourceFile: string, cwd: string, sessionRoot: string) {
  const manager = SessionManager.forkFrom(
    sourceFile,
    cwd,
    cakeWorkspaceSessionDirectory(cwd, sessionRoot),
  );
  return { sessionId: manager.getSessionId(), sessionFile: manager.getSessionFile() ?? undefined };
}

export async function suggestProjectFiles(options: {
  cwd: string;
  prefix: string;
  agentDir: string;
  fdPath?: string;
}): Promise<FileSuggestion[]> {
  const installedFd = join(options.agentDir, "bin", process.platform === "win32" ? "fd.exe" : "fd");
  const provider = new CombinedAutocompleteProvider(
    [],
    options.cwd,
    options.fdPath ?? (existsSync(installedFd) ? installedFd : "fd"),
  );
  const text = `@${options.prefix}`;
  const suggestions = await provider.getSuggestions([text], 0, text.length, {
    signal: AbortSignal.timeout(5_000),
  });
  return (suggestions?.items ?? [])
    .slice(0, 20)
    .map(({ value, label, description }) => ({ value, label, description }));
}

export interface ListWorkspaceSessionsOptions {
  direct?: boolean;
  resolvedSessionDir?: string;
}

export async function listWorkspaceSessions(
  cwd: string,
  sessionDir: string,
  options: ListWorkspaceSessionsOptions = {},
): Promise<SessionSummary[]> {
  const directory = options.direct
    ? resolve(sessionDir)
    : cakeWorkspaceSessionDirectory(cwd, sessionDir);
  const active = (await SessionManager.list(cwd, directory)).map((item) => ({
    item,
    resolved: false,
  }));
  const archived = options.resolvedSessionDir
    ? (
        await SessionManager.list(
          cwd,
          options.direct
            ? resolve(options.resolvedSessionDir)
            : cakeWorkspaceSessionDirectory(cwd, options.resolvedSessionDir),
        )
      ).map((item) => ({ item, resolved: true }))
    : [];
  const sessions = [...active, ...archived];
  const ids = sessions.map(({ item }) => item.id);
  if (new Set(ids).size !== ids.length) {
    console.warn(
      `[cake] Session ID collision across active and resolved namespaces: ${ids.join(", ")}`,
    );
    throw new Error("Session ID collision detected across active and resolved namespaces");
  }
  const idsByFilename = new Map(sessions.map(({ item }) => [basename(item.path), item.id]));
  return sessions.map(({ item, resolved }) => ({
    id: item.id,
    title: (item.name || item.firstMessage || "New chat").slice(0, SESSION_TITLE_MAX_LENGTH),
    created: item.created.toISOString(),
    modified: item.modified.toISOString(),
    messageCount: item.messageCount,
    parentSessionId: item.parentSessionPath
      ? idsByFilename.get(basename(item.parentSessionPath))
      : undefined,
    resolved,
  }));
}

export async function findSessionFile(
  cwd: string,
  sessionId: string,
  sessionDir: string,
  direct = false,
): Promise<string | undefined> {
  const sessions = await SessionManager.list(
    cwd,
    direct ? resolve(sessionDir) : cakeWorkspaceSessionDirectory(cwd, sessionDir),
  );
  return sessions.find((session) => session.id === sessionId)?.path;
}

export async function loadWorkspaceSessionPreview(
  cwd: string,
  sessionId: string,
  sessionDir: string,
  resolvedSessionDir?: string,
  direct = false,
): Promise<SessionPreview | undefined> {
  const activeDirectory = direct
    ? resolve(sessionDir)
    : cakeWorkspaceSessionDirectory(cwd, sessionDir);
  const active = await SessionManager.list(cwd, activeDirectory);
  const activeTarget = active.find((session) => session.id === sessionId);
  const resolvedDirectory = resolvedSessionDir
    ? direct
      ? resolve(resolvedSessionDir)
      : cakeWorkspaceSessionDirectory(cwd, resolvedSessionDir)
    : undefined;
  const resolvedTarget = resolvedDirectory
    ? (await SessionManager.list(cwd, resolvedDirectory)).find(
        (session) => session.id === sessionId,
      )
    : undefined;
  const target = activeTarget ?? resolvedTarget;
  if (!target) return undefined;
  const manager = SessionManager.open(
    target.path,
    activeTarget ? activeDirectory : resolvedDirectory!,
    cwd,
  );
  return {
    workspacePath: cwd,
    sessionId,
    sessionFile: target.path,
    parts: projectSessionEntries(manager.getBranch()),
  };
}
