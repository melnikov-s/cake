import type { Dirent } from "node:fs";
import { lstat, opendir, readdir, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { Effect, Stream } from "effect";
import {
  piProjectSessionDirectory,
  piSessionIdsForWorkingDirectory,
  piSessionMatchesWorkingDirectory,
} from "../pi/PiPaths";

const SESSION_FILE_PATTERN = /^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)_(.+)\.jsonl$/;

export interface SessionFileMetadata {
  readonly id: string;
  readonly path: string;
  readonly createdAt: string;
  readonly modifiedAt: string;
}

/** Pi's normal layout or its configured custom directory; no runtime acquisition. */
export function workingDirectorySessionPath(workingDirectory: string, root: string) {
  return piProjectSessionDirectory(workingDirectory, root).directory;
}

const sessionRouting = (input: {
  readonly workingDirectory: string;
  readonly root: string;
  readonly direct?: boolean;
}) =>
  input.direct
    ? { directory: resolve(input.root), shared: false }
    : piProjectSessionDirectory(input.workingDirectory, input.root);

export function sessionDirectoryPath(input: {
  readonly workingDirectory: string;
  readonly root: string;
  readonly direct?: boolean;
}) {
  return sessionRouting(input).directory;
}

const identityFromFilename = (name: string) => {
  const match = SESSION_FILE_PATTERN.exec(name);
  if (!match) return undefined;
  const [, encodedCreatedAt, id] = match;
  if (!encodedCreatedAt || !id) return undefined;
  const createdAt = encodedCreatedAt.replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, "T$1:$2:$3.$4Z");
  return Number.isNaN(Date.parse(createdAt)) ? undefined : { id, createdAt };
};

const metadataFromFilename = (
  directory: string,
  name: string,
  modifiedAt: Date,
): SessionFileMetadata | undefined => {
  const identity = identityFromFilename(name);
  return identity
    ? {
        ...identity,
        path: join(directory, name),
        modifiedAt: modifiedAt.toISOString(),
      }
    : undefined;
};

const METADATA_STAT_CONCURRENCY = 32;

async function* readDirectorySessionIds(directory: string): AsyncGenerator<string, void, void> {
  let entries;
  try {
    entries = await opendir(directory);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  for await (const entry of entries) {
    if (!entry.isFile()) continue;
    const identity = identityFromFilename(entry.name);
    if (identity) yield identity.id;
  }
}

async function* readDirectoryMetadata(
  directory: string,
  excludedSessionIds: ReadonlySet<string>,
): AsyncGenerator<SessionFileMetadata, void, void> {
  let entries;
  try {
    entries = await opendir(directory);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  let batch: string[] = [];
  const metadataBatch = async (names: readonly string[]) =>
    Promise.all(
      names.map(async (name) =>
        metadataFromFilename(directory, name, (await stat(join(directory, name))).mtime),
      ),
    );
  for await (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    // Only skip unambiguous IDs; malformed names retain their stat/error behavior.
    if (excludedSessionIds.size > 0) {
      const identity = identityFromFilename(entry.name);
      if (identity && excludedSessionIds.has(identity.id)) continue;
    }
    batch.push(entry.name);
    if (batch.length < METADATA_STAT_CONCURRENCY) continue;
    for (const metadata of await metadataBatch(batch)) if (metadata) yield metadata;
    batch = [];
  }
  for (const metadata of await metadataBatch(batch)) if (metadata) yield metadata;
}

/** Shared directories need one SDK pass, never one synchronous lookup per filename. */
function filterWorkingDirectory<A>(
  source: Stream.Stream<A, unknown>,
  directory: string,
  cwd: string | undefined,
  sessionId: (item: A) => string,
): Stream.Stream<A, unknown> {
  if (cwd === undefined) return source;
  return Stream.unwrap(
    Effect.tryPromise({
      try: (signal) => piSessionIdsForWorkingDirectory(cwd, directory, signal),
      catch: (cause) => cause,
    }).pipe(Effect.map((ids) => source.pipe(Stream.filter((item) => ids.has(sessionId(item)))))),
  );
}

/** Filename IDs; only custom shared directories require SDK transcript discovery. */
export function streamSessionFileIds(input: {
  readonly workingDirectory: string;
  readonly root: string;
  readonly direct?: boolean;
}): Stream.Stream<string, unknown> {
  const { directory, shared } = sessionRouting(input);
  return filterWorkingDirectory(
    Stream.fromAsyncIterable(readDirectorySessionIds(directory), (cause) => cause),
    directory,
    shared ? input.workingDirectory : undefined,
    (id) => id,
  );
}

/** Filesystem metadata, with SDK transcript discovery only for custom shared directories. */
export function streamSessionFiles(input: {
  readonly workingDirectory: string;
  readonly root: string;
  readonly direct?: boolean;
  readonly excludedSessionIds?: ReadonlyArray<string>;
}): Stream.Stream<SessionFileMetadata, unknown> {
  const { directory, shared } = sessionRouting(input);
  return filterWorkingDirectory(
    Stream.fromAsyncIterable(
      readDirectoryMetadata(directory, new Set(input.excludedSessionIds)),
      (cause) => cause,
    ),
    directory,
    shared ? input.workingDirectory : undefined,
    (item) => item.id,
  );
}

/** Resolves one exact session file by filename metadata without reading any transcript. */
export async function findSessionFileById(
  sessionId: string,
  input: {
    readonly workingDirectory: string;
    readonly root: string;
    readonly direct?: boolean;
  },
): Promise<string | undefined> {
  return findSessionFileAt(sessionId, input.workingDirectory, sessionRouting(input));
}

/** Recovery presence without title parsing. Retain catalog filename eligibility
 * and reject empty originals rather than letting Pi initialize them as new history. */
export async function hasSessionFileById(
  sessionId: string,
  input: { readonly workingDirectory: string; readonly root: string; readonly direct?: boolean },
): Promise<boolean> {
  const file = await findSessionFileById(sessionId, input);
  if (!file || !identityFromFilename(basename(file))) return false;
  const info = await stat(file);
  if (!info.isFile() || info.size === 0)
    throw new Error(`Session transcript requires a nonempty regular file: ${file}`);
  return true;
}

async function findSessionFileAt(
  sessionId: string,
  cwd: string,
  { directory, shared }: { readonly directory: string; readonly shared: boolean },
): Promise<string | undefined> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
  const suffix = `_${sessionId}.jsonl`;
  const matches = entries.filter((entry) => entry.isFile() && entry.name.endsWith(suffix));
  if (matches.length > 1) throw new Error(`Session ID collision detected: ${sessionId}`);
  if (shared && !piSessionMatchesWorkingDirectory(cwd, sessionId, directory)) return undefined;
  return matches[0] ? join(directory, matches[0].name) : undefined;
}

/** A single discovery generation, not live transcript authority. No bodies, stats,
 * watchers or cross-generation cache. Namespace changes after the listing (including
 * new collisions) are visible in the next generation; metadata hits are re-statted
 * and stale failures propagate. Never pass this evidence to recovery or mutations. */
export interface SessionFileSnapshot {
  readonly directory: string;
  readonly workingDirectory: string;
  readonly shared: boolean;
  readonly find: (sessionId: string) => string | undefined;
}

/** One listing and an exact suffix index, including Pi IDs containing underscores
 * and malformed timestamp prefixes accepted by the historical exact lookup. */
export async function snapshotSessionFiles(
  input: { readonly workingDirectory: string; readonly root: string; readonly direct?: boolean },
  signal: AbortSignal,
): Promise<SessionFileSnapshot> {
  signal.throwIfAborted();
  const { directory, shared } = sessionRouting(input);
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    entries = [];
  }
  signal.throwIfAborted();
  const files = new Map<string, string | null>();
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    const path = join(directory, entry.name);
    for (
      let index = entry.name.indexOf("_");
      index !== -1;
      index = entry.name.indexOf("_", index + 1)
    ) {
      const id = entry.name.slice(index + 1, -6);
      files.set(id, files.has(id) ? null : path);
    }
  }
  // Keep collision evidence before cwd filtering, just like exact lookup.
  const allowed =
    shared && files.size > 0
      ? await piSessionIdsForWorkingDirectory(input.workingDirectory, directory, signal)
      : undefined;
  signal.throwIfAborted();
  return Object.freeze({
    directory,
    shared,
    workingDirectory: resolve(input.workingDirectory),
    find: (sessionId: string) => {
      signal.throwIfAborted();
      const path = files.get(sessionId);
      if (path === null) throw new Error(`Session ID collision detected: ${sessionId}`);
      return allowed && !allowed.has(sessionId) ? undefined : path;
    },
  });
}

/** Request-local filename discovery: one directory listing, no per-entry scans or stats. */
export async function findSessionFilesByIds(
  sessionIds: ReadonlySet<string>,
  input: { readonly workingDirectory: string; readonly root: string; readonly direct?: boolean },
  signal: AbortSignal,
): Promise<ReadonlyMap<string, string>> {
  signal.throwIfAborted();
  const { directory, shared } = sessionRouting(input);
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return new Map();
    throw error;
  }
  signal.throwIfAborted();
  const files = new Map<string, string>();
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    // Match the exact lookup's suffix semantics, including malformed timestamps
    // and IDs containing underscores. Detect collisions before cwd filtering.
    for (
      let index = entry.name.indexOf("_");
      index !== -1;
      index = entry.name.indexOf("_", index + 1)
    ) {
      const id = entry.name.slice(index + 1, -6);
      if (!sessionIds.has(id)) continue;
      if (files.has(id)) throw new Error(`Session ID collision detected: ${id}`);
      files.set(id, join(directory, entry.name));
    }
  }
  if (shared && files.size > 0) {
    const allowed = await piSessionIdsForWorkingDirectory(
      input.workingDirectory,
      directory,
      signal,
    );
    for (const id of files.keys()) if (!allowed.has(id)) files.delete(id);
  }
  signal.throwIfAborted();
  return files;
}

/** Reads metadata for one exact session file without opening its transcript body. */
export async function findSessionFileMetadataById(
  sessionId: string,
  input: {
    readonly workingDirectory: string;
    readonly root: string;
    readonly direct?: boolean;
    readonly fileSnapshot?: SessionFileSnapshot;
  },
): Promise<SessionFileMetadata | undefined> {
  const routing = sessionRouting(input);
  const snapshot = input.fileSnapshot;
  if (
    snapshot &&
    (snapshot.directory !== routing.directory ||
      snapshot.shared !== routing.shared ||
      snapshot.workingDirectory !== resolve(input.workingDirectory))
  )
    throw new Error("Session file snapshot routing mismatch");
  const path = snapshot
    ? snapshot.find(sessionId)
    : await findSessionFileAt(sessionId, input.workingDirectory, routing);
  if (!path) return undefined;
  // The generation owns filenames only. Never follow a replaced symlink or hide
  // deletion/permission failures by retrying stale evidence as a missing history.
  const info = await lstat(path);
  if (!info.isFile()) throw new Error(`Session transcript requires a regular file: ${path}`);
  return metadataFromFilename(routing.directory, basename(path), info.mtime);
}
