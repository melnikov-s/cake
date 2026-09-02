import { Effect, Layer, Schema } from "effect";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  artifactRecordSchema,
  parseArtifactInput,
  type ArtifactRecord,
  type CakeArtifactV1,
} from "../../ipc/artifact-contract";
import { AtomicFileWriter } from "./internal/AtomicFileWriter";
import { KeyedSerialExecutor } from "../../utils/KeyedSerialExecutor";
import { ArtifactStorage, ArtifactStorageError } from "./ArtifactStorage";

interface StoredArtifactMetadata {
  protocol: "cake.artifact/v1";
  id: string;
  sessionId: string;
  workspacePath: string;
  revision: number;
  kind: CakeArtifactV1["kind"];
  digest: string;
  createdAt: string;
  updatedAt: string;
}

const storedArtifactMetadataSchema: Schema.Codec<StoredArtifactMetadata> = Schema.Struct({
  protocol: Schema.Literal("cake.artifact/v1"),
  id: Schema.String,
  sessionId: Schema.String,
  workspacePath: Schema.String,
  revision: Schema.Int.check(Schema.isGreaterThan(0)),
  kind: Schema.Literals([
    "markdown",
    "table",
    "diagram",
    "form",
    "media",
    "diff",
    "html",
    "widget",
    "request",
  ]),
  digest: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});

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

  async get(
    workspacePath: string,
    sessionId: string,
    artifactId: string,
  ): Promise<ArtifactRecord | undefined> {
    try {
      const metadata = Schema.decodeUnknownSync(storedArtifactMetadataSchema)(
        JSON.parse(await readFile(this.recordPath(workspacePath, sessionId, artifactId), "utf8")),
      );
      const artifact = JSON.parse(await readFile(this.blobPath(metadata.digest), "utf8"));
      return Schema.decodeUnknownSync(artifactRecordSchema)({ artifact, ...metadata });
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
          return this.get(metadata.workspacePath, metadata.sessionId, metadata.id);
        }),
    );
    return records
      .filter((record): record is ArtifactRecord => Boolean(record))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async linkSession(record: ArtifactRecord, sessionId: string): Promise<void> {
    await mkdir(this.recordDirectory(record.workspacePath, sessionId), {
      recursive: true,
      mode: 0o700,
    });
    await this.writer.write(
      this.recordPath(record.workspacePath, sessionId, record.artifact.id),
      `${JSON.stringify(toMetadata(record), null, 2)}\n`,
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

function toMetadata(record: ArtifactRecord): StoredArtifactMetadata {
  return {
    protocol: "cake.artifact/v1",
    id: record.artifact.id,
    sessionId: record.artifact.sessionId,
    workspacePath: record.workspacePath,
    revision: record.artifact.revision,
    kind: record.artifact.kind,
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
