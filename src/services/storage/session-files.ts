import { opendir, readdir, stat } from "node:fs/promises";
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

const isSharedProjectDirectory = (input: {
  workingDirectory: string;
  root: string;
  direct?: boolean;
}) => !input.direct && piProjectSessionDirectory(input.workingDirectory, input.root).shared;

export function sessionDirectoryPath(input: {
  readonly workingDirectory: string;
  readonly root: string;
  readonly direct?: boolean;
}) {
  return input.direct
    ? resolve(input.root)
    : workingDirectorySessionPath(input.workingDirectory, input.root);
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
  const directory = sessionDirectoryPath(input);
  const shared = isSharedProjectDirectory(input);
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
}): Stream.Stream<SessionFileMetadata, unknown> {
  const directory = sessionDirectoryPath(input);
  const shared = isSharedProjectDirectory(input);
  return filterWorkingDirectory(
    Stream.fromAsyncIterable(readDirectoryMetadata(directory), (cause) => cause),
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
  const directory = sessionDirectoryPath(input);
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
  if (
    isSharedProjectDirectory(input) &&
    !piSessionMatchesWorkingDirectory(input.workingDirectory, sessionId, directory)
  )
    return undefined;
  return matches[0] ? join(directory, matches[0].name) : undefined;
}

/** Reads metadata for one exact session file without opening its transcript body. */
export async function findSessionFileMetadataById(
  sessionId: string,
  input: {
    readonly workingDirectory: string;
    readonly root: string;
    readonly direct?: boolean;
  },
): Promise<SessionFileMetadata | undefined> {
  const path = await findSessionFileById(sessionId, input);
  if (!path) return undefined;
  return metadataFromFilename(
    sessionDirectoryPath(input),
    basename(path),
    (await stat(path)).mtime,
  );
}
