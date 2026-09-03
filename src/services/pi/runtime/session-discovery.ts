import {
  SessionManager,
  getPackageDir,
  hasTrustRequiringProjectResources,
} from "@earendil-works/pi-coding-agent";
import { CombinedAutocompleteProvider } from "@earendil-works/pi-tui";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Stream } from "effect";
import {
  SESSION_TITLE_MAX_LENGTH,
  type FileSuggestion,
  type SessionPreview,
  type SessionSummary,
} from "../../../ipc/session-contract";
import { projectSessionEntries } from "./session-projection";
import {
  findSessionFileById,
  streamSessionFiles,
  workingDirectorySessionPath,
} from "../../storage/session-files";

export function loadPiChangelog() {
  try {
    return readFileSync(join(getPackageDir(), "CHANGELOG.md"), "utf8");
  } catch {
    return "# Changelog\n\nNo changelog entries found.";
  }
}

/** Resolve the Cake source tree that matches the running authoring skill. */
export function cakePluginAuthoringSkillPath(
  authoringRoot = process.env.CAKE_AUTHORING_ROOT ?? resolve(import.meta.dirname, "../../../.."),
) {
  return join(authoringRoot, ".agents", "skills", "cake-plugin-authoring");
}

export function inspectWorkspace(path: string) {
  return { path, trustRequired: hasTrustRequiringProjectResources(path) };
}

/** Mirror Pi's documented per-workspace directory layout beneath Cake's session root. */
export function cakeWorkspaceSessionDirectory(cwd: string, sessionRoot: string) {
  return workingDirectorySessionPath(cwd, sessionRoot);
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

export interface StreamWorkspaceSessionsOptions {
  direct?: boolean;
  titles?: ReadonlyMap<string, string>;
}

/** Streams cheap file metadata for active sessions without opening transcript bodies. */
export function streamWorkspaceSessions(
  cwd: string,
  sessionDir: string,
  options: StreamWorkspaceSessionsOptions = {},
): Stream.Stream<SessionSummary, unknown> {
  return streamSessionFiles({
    workingDirectory: cwd,
    root: sessionDir,
    direct: options.direct,
  }).pipe(
    Stream.map((item) => ({
      id: item.id,
      title: (options.titles?.get(item.id) ?? item.id).slice(0, SESSION_TITLE_MAX_LENGTH),
      created: item.createdAt,
      modified: item.modifiedAt,
      messageCount: 0,
      resolved: false,
    })),
  );
}

export async function findSessionFile(
  cwd: string,
  sessionId: string,
  sessionDir: string,
  direct = false,
): Promise<string | undefined> {
  return findSessionFileById(sessionId, {
    workingDirectory: cwd,
    root: sessionDir,
    direct,
  });
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
  const activeTarget = await findSessionFile(cwd, sessionId, sessionDir, direct);
  const resolvedDirectory = resolvedSessionDir
    ? direct
      ? resolve(resolvedSessionDir)
      : cakeWorkspaceSessionDirectory(cwd, resolvedSessionDir)
    : undefined;
  const resolvedTarget = resolvedSessionDir
    ? await findSessionFile(cwd, sessionId, resolvedSessionDir, direct)
    : undefined;
  const target = activeTarget ?? resolvedTarget;
  if (!target) return undefined;
  const manager = SessionManager.open(
    target,
    activeTarget ? activeDirectory : resolvedDirectory!,
    cwd,
  );
  return {
    workspacePath: cwd,
    sessionId,
    sessionFile: target,
    parts: projectSessionEntries(manager.getBranch()),
  };
}
