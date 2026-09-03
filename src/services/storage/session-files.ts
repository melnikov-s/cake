import { opendir, readdir, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { Stream } from "effect";

const SESSION_FILE_PATTERN = /^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)_(.+)\.jsonl$/;

export interface SessionFileMetadata {
  readonly id: string;
  readonly path: string;
  readonly createdAt: string;
  readonly modifiedAt: string;
}

/** Mirror Pi's documented per-working-directory layout without opening a Pi runtime. */
export function workingDirectorySessionPath(workingDirectory: string, root: string) {
  const normalized = resolve(workingDirectory);
  const safePath = `--${normalized.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return join(resolve(root), safePath);
}

export function sessionDirectoryPath(input: {
  readonly workingDirectory: string;
  readonly root: string;
  readonly direct?: boolean;
}) {
  return input.direct
    ? resolve(input.root)
    : workingDirectorySessionPath(input.workingDirectory, input.root);
}

const metadataFromFilename = (
  directory: string,
  name: string,
  modifiedAt: Date,
): SessionFileMetadata | undefined => {
  const match = SESSION_FILE_PATTERN.exec(name);
  if (!match) return undefined;
  const [, encodedCreatedAt, id] = match;
  if (!encodedCreatedAt || !id) return undefined;
  const createdAt = encodedCreatedAt.replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, "T$1:$2:$3.$4Z");
  if (Number.isNaN(Date.parse(createdAt))) return undefined;
  return {
    id,
    path: join(directory, name),
    createdAt,
    modifiedAt: modifiedAt.toISOString(),
  };
};

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
  for await (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    const metadata = metadataFromFilename(
      directory,
      entry.name,
      (await stat(join(directory, entry.name))).mtime,
    );
    if (metadata) yield metadata;
  }
}

/** Emits filesystem metadata only. Transcript contents are never opened. */
export function streamSessionFiles(input: {
  readonly workingDirectory: string;
  readonly root: string;
  readonly direct?: boolean;
}): Stream.Stream<SessionFileMetadata, unknown> {
  const directory = sessionDirectoryPath(input);
  return Stream.fromAsyncIterable(readDirectoryMetadata(directory), (cause) => cause);
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
