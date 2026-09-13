import { Effect, Layer, Schema } from "effect";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  artifactRecordSchema,
  parseArtifactInput,
  type ArtifactPointer,
  type ArtifactRecord,
  type CakeArtifactV1,
} from "../../ipc/artifact-contract";
import { AtomicFileWriter } from "./internal/AtomicFileWriter";
import { KeyedSerialExecutor } from "../../utils/KeyedSerialExecutor";
import { ArtifactStorage, ArtifactStorageError } from "./ArtifactStorage";

type StoredArtifactKind = CakeArtifactV1["kind"] | "architecture";

interface StoredArtifactMetadata {
  protocol: "cake.artifact/v1";
  id: string;
  sessionId: string;
  workspacePath: string;
  revision: number;
  kind: StoredArtifactKind;
  digest: string;
  createdAt: string;
  updatedAt: string;
}

const storedIdSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(256),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
);
const storedFallbackSchema = Schema.Struct({
  markdown: Schema.String.check(Schema.isMaxLength(1_048_576)),
});
const historicalArchitectureArtifactSchema = Schema.Struct({
  protocol: Schema.Literal("cake.artifact/v1"),
  id: storedIdSchema,
  sessionId: storedIdSchema,
  revision: Schema.Int.check(Schema.isGreaterThan(0)),
  kind: Schema.Literal("architecture"),
  title: Schema.optional(Schema.String.check(Schema.isMaxLength(512))),
  payload: Schema.Unknown,
  fallback: storedFallbackSchema,
  interaction: Schema.optional(
    Schema.Struct({
      mode: Schema.Literal("present"),
      responseSchema: Schema.optional(Schema.Unknown),
    }),
  ),
});

const storedArtifactMetadataSchema: Schema.Codec<StoredArtifactMetadata> = Schema.Struct({
  protocol: Schema.Literal("cake.artifact/v1"),
  id: storedIdSchema,
  sessionId: storedIdSchema,
  workspacePath: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_096)),
  revision: Schema.Int.check(Schema.isGreaterThan(0)),
  kind: Schema.Literals([
    "markdown",
    "table",
    "diagram",
    "architecture",
    "form",
    "media",
    "diff",
    "html",
    "widget",
    "file",
    "request",
  ]),
  digest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});

interface DecodedStoredArtifact {
  readonly artifact: CakeArtifactV1;
  readonly storedKind: StoredArtifactKind;
}

function decodeStoredArtifact(untrustedInput: unknown): DecodedStoredArtifact {
  const historical = Schema.decodeUnknownOption(historicalArchitectureArtifactSchema)(
    untrustedInput,
  );
  if (historical._tag === "Some") {
    const artifact = historical.value;
    return {
      storedKind: "architecture",
      artifact: parseArtifactInput({
        protocol: artifact.protocol,
        id: artifact.id,
        sessionId: artifact.sessionId,
        revision: artifact.revision,
        kind: "markdown",
        title: artifact.title,
        payload: { markdown: artifact.fallback.markdown },
        fallback: artifact.fallback,
        interaction: { mode: "present" },
      }),
    };
  }
  const artifact = parseArtifactInput(untrustedInput);
  return { artifact, storedKind: artifact.kind };
}

function hydrateStoredRecord(serialized: string, metadata: StoredArtifactMetadata): ArtifactRecord {
  const digest = createHash("sha256").update(serialized).digest("hex");
  if (digest !== metadata.digest) throw new Error(`Artifact ${metadata.id} digest does not match`);
  const decoded = decodeStoredArtifact(JSON.parse(serialized));
  if (
    decoded.artifact.id !== metadata.id ||
    decoded.artifact.sessionId !== metadata.sessionId ||
    decoded.artifact.revision !== metadata.revision ||
    decoded.storedKind !== metadata.kind
  )
    throw new Error(`Artifact ${metadata.id} metadata does not match its immutable blob`);
  return Schema.decodeUnknownSync(artifactRecordSchema)({
    artifact: decoded.artifact,
    workspacePath: metadata.workspacePath,
    digest: metadata.digest,
    createdAt: metadata.createdAt,
    updatedAt: metadata.updatedAt,
  });
}

class ArtifactRepository {
  private readonly updates = new KeyedSerialExecutor<string>();
  private readonly writer = new AtomicFileWriter();
  constructor(private readonly root: string) {}

  async upsert(workspacePath: string, untrustedInput: unknown): Promise<ArtifactRecord> {
    const artifact = parseArtifactInput(untrustedInput);
    const key = this.recordPath(workspacePath, artifact.sessionId, artifact.id);
    return this.updates.run(key, async () => {
      const existing = await this.get(workspacePath, artifact.sessionId, artifact.id);
      if (existing && artifact.revision !== existing.artifact.revision + 1) {
        throw new Error(
          `Artifact ${artifact.id} revision must advance from ${existing.artifact.revision} to ${existing.artifact.revision + 1}`,
        );
      }
      if (!existing && artifact.revision !== 1)
        throw new Error(`New artifact ${artifact.id} must start at revision 1`);

      const serialized = `${JSON.stringify(artifact, null, 2)}\n`;
      const digest = createHash("sha256").update(serialized).digest("hex");
      const now = new Date().toISOString();
      const record = Schema.decodeUnknownSync(artifactRecordSchema)({
        artifact,
        workspacePath,
        digest,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      });
      await mkdir(this.blobDirectory(), { recursive: true, mode: 0o700 });
      await mkdir(this.recordDirectory(workspacePath, artifact.sessionId), {
        recursive: true,
        mode: 0o700,
      });
      await this.writer.write(this.blobPath(digest), serialized);
      await this.writer.write(key, `${JSON.stringify(toMetadata(record), null, 2)}\n`);
      return record;
    });
  }

  async deleteSession(workspacePath: string, sessionId: string) {
    await rm(this.recordDirectory(workspacePath, sessionId), { recursive: true, force: true });
  }

  async inheritFork(
    sourceWorkspacePath: string,
    sourceSessionId: string,
    destinationWorkspacePath: string,
    destinationSessionId: string,
    pointers: ReadonlyArray<ArtifactPointer>,
  ): Promise<void> {
    const sourceRecords = await this.listSession(sourceWorkspacePath, sourceSessionId);
    const recordsById = new Map(sourceRecords.map((record) => [record.artifact.id, record]));
    const inherited = await Promise.all(
      pointers.map(async (pointer) => {
        const serialized = await readFile(this.blobPath(pointer.digest), "utf8");
        const digest = createHash("sha256").update(serialized).digest("hex");
        const decoded = decodeStoredArtifact(JSON.parse(serialized));
        if (
          digest !== pointer.digest ||
          decoded.artifact.id !== pointer.artifactId ||
          decoded.artifact.sessionId !== pointer.sessionId ||
          decoded.artifact.revision !== pointer.revision ||
          decoded.storedKind !== pointer.kind
        )
          throw new Error(
            `Artifact ${pointer.artifactId} revision ${pointer.revision} does not match its source pointer`,
          );
        const current = recordsById.get(pointer.artifactId);
        if (!current)
          throw new Error(
            `Artifact ${pointer.artifactId} is not associated with source session ${sourceSessionId}`,
          );
        const now = new Date().toISOString();
        const record = Schema.decodeUnknownSync(artifactRecordSchema)({
          artifact: decoded.artifact,
          workspacePath: destinationWorkspacePath,
          digest,
          createdAt: current.createdAt ?? now,
          updatedAt: current.updatedAt ?? now,
        });
        return { record, storedKind: decoded.storedKind };
      }),
    );

    await Promise.all(
      inherited.map(({ record, storedKind }) =>
        this.linkSession(record, destinationSessionId, storedKind),
      ),
    );
  }

  async get(
    workspacePath: string,
    sessionId: string,
    artifactId: string,
  ): Promise<ArtifactRecord | undefined> {
    try {
      const metadata = Schema.decodeUnknownSync(storedArtifactMetadataSchema)(
        JSON.parse(await readFile(this.recordPath(workspacePath, sessionId, artifactId), "utf8")),
      );
      if (metadata.workspacePath !== workspacePath)
        throw new Error(`Artifact ${metadata.id} workspace metadata does not match its index`);
      const serialized = await readFile(this.blobPath(metadata.digest), "utf8");
      return hydrateStoredRecord(serialized, metadata);
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
  }

  async listSession(workspacePath: string, sessionId: string): Promise<ArtifactRecord[]> {
    let names: string[];
    try {
      names = await readdir(this.recordDirectory(workspacePath, sessionId));
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    const records = await Promise.all(
      names
        .filter((name) => name.endsWith(".json"))
        .map(async (name) => {
          const metadata = Schema.decodeUnknownSync(storedArtifactMetadataSchema)(
            JSON.parse(
              await readFile(join(this.recordDirectory(workspacePath, sessionId), name), "utf8"),
            ),
          );
          return this.get(workspacePath, sessionId, metadata.id);
        }),
    );
    return records
      .filter((record): record is ArtifactRecord => Boolean(record))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async linkSession(
    record: ArtifactRecord,
    sessionId: string,
    storedKind: StoredArtifactKind = record.artifact.kind,
  ): Promise<void> {
    await mkdir(this.recordDirectory(record.workspacePath, sessionId), {
      recursive: true,
      mode: 0o700,
    });
    await this.writer.write(
      this.recordPath(record.workspacePath, sessionId, record.artifact.id),
      `${JSON.stringify(toMetadata(record, storedKind), null, 2)}\n`,
    );
  }

  async exportMarkdown(workspacePath: string, sessionId: string): Promise<string> {
    const records = await this.listSession(workspacePath, sessionId);
    return records
      .map(({ artifact }) => `## ${artifact.title ?? artifact.id}\n\n${artifact.fallback.markdown}`)
      .join("\n\n---\n\n");
  }

  private blobDirectory() {
    return join(this.root, "blobs");
  }
  private blobPath(digest: string) {
    return join(this.blobDirectory(), `${digest}.json`);
  }
  private recordDirectory(workspacePath: string, sessionId: string) {
    return join(this.root, "sessions", digestKey(workspacePath), digestKey(sessionId));
  }
  private recordPath(workspacePath: string, sessionId: string, artifactId: string) {
    return join(this.recordDirectory(workspacePath, sessionId), `${digestKey(artifactId)}.json`);
  }
}

function toMetadata(
  record: ArtifactRecord,
  kind: StoredArtifactKind = record.artifact.kind,
): StoredArtifactMetadata {
  return {
    protocol: "cake.artifact/v1",
    id: record.artifact.id,
    sessionId: record.artifact.sessionId,
    workspacePath: record.workspacePath,
    revision: record.artifact.revision,
    kind,
    digest: record.digest,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function digestKey(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function isMissing(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

const storageError = (operation: string, cause: unknown) =>
  new ArtifactStorageError({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
  });

const makeArtifactStorageService = (root: string) => {
  const repository = new ArtifactRepository(root);
  const attempt = <A>(operation: string, evaluate: () => Promise<A>) =>
    Effect.tryPromise({
      try: evaluate,
      catch: (cause) => storageError(operation, cause),
    });
  const service = ArtifactStorage.of({
    upsert: Effect.fn("ArtifactStorage.upsert")((workingDirectory, artifact) =>
      attempt("upsert", () => repository.upsert(workingDirectory, artifact)),
    ),
    get: Effect.fn("ArtifactStorage.get")((workingDirectory, sessionId, artifactId) =>
      attempt("get", () => repository.get(workingDirectory, sessionId, artifactId)),
    ),
    listSession: Effect.fn("ArtifactStorage.listSession")((workingDirectory, sessionId) =>
      attempt("listSession", () => repository.listSession(workingDirectory, sessionId)),
    ),
    linkSession: Effect.fn("ArtifactStorage.linkSession")((record, sessionId) =>
      attempt("linkSession", () => repository.linkSession(record, sessionId)),
    ),
    inheritFork: Effect.fn("ArtifactStorage.inheritFork")(
      (
        sourceWorkingDirectory,
        sourceSessionId,
        destinationWorkingDirectory,
        destinationSessionId,
        pointers,
      ) =>
        attempt("inheritFork", () =>
          repository.inheritFork(
            sourceWorkingDirectory,
            sourceSessionId,
            destinationWorkingDirectory,
            destinationSessionId,
            pointers,
          ),
        ),
    ),
    deleteSession: Effect.fn("ArtifactStorage.deleteSession")((workingDirectory, sessionId) =>
      attempt("deleteSession", () => repository.deleteSession(workingDirectory, sessionId)),
    ),
    exportMarkdown: Effect.fn("ArtifactStorage.exportMarkdown")((workingDirectory, sessionId) =>
      attempt("exportMarkdown", () => repository.exportMarkdown(workingDirectory, sessionId)),
    ),
  });
  return service;
};

export const makeArtifactStorageTestAdapter = (root: string) => {
  const service = makeArtifactStorageService(root);
  return { service, layer: Layer.succeed(ArtifactStorage, service) } as const;
};

export const makeArtifactStorageLive = (root: string) =>
  Layer.sync(ArtifactStorage, () => makeArtifactStorageService(root));
