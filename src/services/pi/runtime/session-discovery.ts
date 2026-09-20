import {
  SessionManager,
  getPackageDir,
  hasTrustRequiringProjectResources,
} from "@earendil-works/pi-coding-agent";
import { CombinedAutocompleteProvider } from "@earendil-works/pi-tui";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Effect, Stream } from "effect";
import {
  type FileSuggestion,
  type PiSessionPreview,
  type PiSessionSummary,
} from "../../../ipc/session-contract";
import {
  projectArtifactPointers,
  projectDurableArtifactLineageIds,
  projectSessionEntries,
} from "./session-projection";
import { sessionTitleFromFile } from "./session-title";
import {
  findSessionFileMetadataById,
  findSessionFileById,
  streamSessionFileIds,
  streamSessionFiles,
  workingDirectorySessionPath,
} from "../../storage/session-files";

export interface DurableArtifactReferences {
  readonly sessionIds: ReadonlyArray<string>;
  readonly lineageIds: ReadonlyArray<string>;
}

/** Enumerates durable pointers through Pi's SessionManager rather than parsing Pi JSONL. */
export async function loadDurableArtifactReferences(
  sessionRoots: ReadonlyArray<string>,
): Promise<DurableArtifactReferences> {
  const sessionIds = new Set<string>();
  const lineageIds = new Set<string>();
  for (const root of sessionRoots) {
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch (cause) {
      if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") continue;
      throw cause;
    }
    if (entries.some((entry) => entry.isSymbolicLink()))
      throw new Error(`Cannot verify durable artifact reachability through symlinks in ${root}`);
    const directories = [
      root,
      ...entries.filter((entry) => entry.isDirectory()).map((entry) => join(root, entry.name)),
    ];
    for (const directory of directories) {
      const directoryEntries = await readdir(directory, { withFileTypes: true });
      if (
        directoryEntries.some(
          (entry) => entry.name.endsWith(".jsonl") && (!entry.isFile() || entry.isSymbolicLink()),
        )
      )
        throw new Error(`Cannot verify non-regular Pi Session files in ${directory}`);
      const expectedPaths = new Set(
        directoryEntries
          .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
          .map((entry) => resolve(directory, entry.name)),
      );
      const sessions = await SessionManager.listAll(directory);
      const listedPaths = new Set(sessions.map((session) => resolve(session.path)));
      if (
        expectedPaths.size !== listedPaths.size ||
        [...expectedPaths].some((sessionPath) => !listedPaths.has(sessionPath))
      )
        throw new Error(`Pi could not authoritatively enumerate every Session in ${directory}`);
      for (const session of sessions) {
        if (sessionIds.has(session.id))
          throw new Error(
            `Pi Session ID collision detected while scanning artifact pointers: ${session.id}`,
          );
        sessionIds.add(session.id);
        const manager = SessionManager.open(session.path, dirname(session.path), session.cwd);
        for (const lineageId of projectDurableArtifactLineageIds(manager))
          lineageIds.add(lineageId);
      }
    }
  }
  return { sessionIds: [...sessionIds], lineageIds: [...lineageIds] };
}

export function loadPiChangelog() {
  try {
    return readFileSync(join(getPackageDir(), "CHANGELOG.md"), "utf8");
  } catch {
    return "# Changelog\n\nNo changelog entries found.";
  }
}

/** Loads cheap metadata for one active session without opening its transcript body. */
export async function loadWorkspacePiSessionSummary(
  cwd: string,
  sessionId: string,
  sessionDir: string,
  options: StreamWorkspaceSessionsOptions = {},
): Promise<PiSessionSummary | undefined> {
  const item = await findSessionFileMetadataById(sessionId, {
    workingDirectory: cwd,
    root: sessionDir,
    direct: options.direct,
  });
  return item
    ? {
        id: item.id,
        title: sessionTitleFromFile(item.path, cwd),
        created: item.createdAt,
        modified: item.modifiedAt,
        messageCount: 0,
        resolved: false,
      }
    : undefined;
}

export function inspectWorkspace(path: string) {
  return { path, trustRequired: hasTrustRequiringProjectResources(path) };
}

/** Mirror Pi's documented per-workspace directory layout beneath Cake's session root. */
export function cakeWorkspaceSessionDirectory(cwd: string, sessionRoot: string) {
  return workingDirectorySessionPath(cwd, sessionRoot);
}

export function forkWorkspaceSession(
  sourceFile: string,
  sourceCwd: string,
  entryId: string,
  destinationCwd: string,
  sessionRoot: string,
  title: string,
) {
  const source = SessionManager.open(sourceFile, dirname(sourceFile), sourceCwd);
  const branchFile = source.createBranchedSession(entryId);
  if (!branchFile) throw new Error("The current session is not persisted");
  try {
    const manager = SessionManager.forkFrom(
      branchFile,
      destinationCwd,
      cakeWorkspaceSessionDirectory(destinationCwd, sessionRoot),
    );
    manager.appendSessionInfo(title);
    return {
      sessionId: manager.getSessionId(),
      sessionFile: manager.getSessionFile() ?? undefined,
      artifactPointers: projectArtifactPointers(manager),
    };
  } finally {
    unlinkSync(branchFile);
  }
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
}

/** Streams active session IDs from filenames without reading transcript titles or file metadata. */
export function streamWorkspaceSessionIds(
  cwd: string,
  sessionDir: string,
  options: StreamWorkspaceSessionsOptions = {},
): Stream.Stream<string, unknown> {
  return streamSessionFileIds({
    workingDirectory: cwd,
    root: sessionDir,
    direct: options.direct,
  });
}

/** Streams cheap file metadata for active sessions without opening transcript bodies. */
export function streamWorkspaceSessions(
  cwd: string,
  sessionDir: string,
  options: StreamWorkspaceSessionsOptions = {},
): Stream.Stream<PiSessionSummary, unknown> {
  return streamSessionFiles({
    workingDirectory: cwd,
    root: sessionDir,
    direct: options.direct,
  }).pipe(
    Stream.mapEffect(
      (item) =>
        Effect.try({
          try: () => ({
            id: item.id,
            title: sessionTitleFromFile(item.path, cwd),
            created: item.createdAt,
            modified: item.modifiedAt,
            messageCount: 0,
            resolved: false,
          }),
          catch: (cause) => cause,
        }),
      { concurrency: 16 },
    ),
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

export async function loadWorkspacePiSessionPreview(
  cwd: string,
  sessionId: string,
  sessionDir: string,
  resolvedSessionDir?: string,
  direct = false,
): Promise<PiSessionPreview | undefined> {
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
  const branch = manager.getBranch();
  let model: { provider: string; modelId: string } | undefined;
  for (const entry of branch) {
    if (entry.type === "model_change") model = { provider: entry.provider, modelId: entry.modelId };
    else if (entry.type === "message" && entry.message.role === "assistant")
      model = {
        provider: entry.message.provider,
        modelId: entry.message.responseModel ?? entry.message.model,
      };
  }
  return {
    workspacePath: cwd,
    sessionId,
    sessionFile: target,
    parts: projectSessionEntries(branch),
    ...(model ? { currentModel: model } : undefined),
  };
}
