import {
  DateTime,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  RcMap,
  Schema,
  Semaphore,
} from "effect";
import { createHash } from "node:crypto";
import {
  artifactRecordSchema,
  parseArtifactInput,
  type ArtifactPointer,
  type ArtifactRecord,
  type CakeArtifactV1,
} from "../../ipc/artifact-contract";
import { ArtifactStorage, ArtifactStorageError } from "./ArtifactStorage";
import { atomicWriteFile } from "./internal/atomicFile";

type StoredArtifactKind = CakeArtifactV1["kind"] | "architecture";

interface StoredArtifactMetadata {
  readonly protocol: "cake.artifact/v1";
  readonly id: string;
  readonly sessionId: string;
  readonly workspacePath: string;
  readonly revision: number;
  readonly kind: StoredArtifactKind;
  readonly digest: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface DecodedStoredArtifact {
  readonly artifact: CakeArtifactV1;
  readonly storedKind: StoredArtifactKind;
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

const storageError = (operation: string, cause: unknown) =>
  new ArtifactStorageError({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
  });

const attempt = <A>(operation: string, evaluate: () => A) =>
  Effect.try({ try: evaluate, catch: (cause) => storageError(operation, cause) });

const parseJson = (operation: string, text: string) =>
  attempt<unknown>(operation, () => JSON.parse(text));

const decodeArtifactInput = <Input>(input: Input) =>
  attempt("decode", () => parseArtifactInput(input));

const decodeStoredArtifact = Effect.fn("ArtifactStorage.decodeStoredArtifact")(function* <Input>(
  input: Input,
): Effect.fn.Return<DecodedStoredArtifact, ArtifactStorageError> {
  const historical = yield* Schema.decodeUnknownEffect(historicalArchitectureArtifactSchema)(
    input,
  ).pipe(Effect.option);
  if (Option.isSome(historical)) {
    const value = historical.value;
    const artifact = yield* decodeArtifactInput({
      protocol: value.protocol,
      id: value.id,
      sessionId: value.sessionId,
      revision: value.revision,
      kind: "markdown",
      title: value.title,
      payload: { markdown: value.fallback.markdown },
      fallback: value.fallback,
      interaction: { mode: "present" },
    });
    return { artifact, storedKind: "architecture" };
  }
  const artifact = yield* decodeArtifactInput(input);
  return { artifact, storedKind: artifact.kind };
});

const decodeMetadata = <Input>(input: Input) =>
  Schema.decodeUnknownEffect(storedArtifactMetadataSchema)(input).pipe(
    Effect.mapError((cause) => storageError("decode", cause)),
  );

const decodeRecord = <Input>(input: Input) =>
  Schema.decodeUnknownEffect(artifactRecordSchema)(input).pipe(
    Effect.mapError((cause) => storageError("decode", cause)),
  );

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const digestKey = digest;

const toMetadata = (
  record: ArtifactRecord,
  kind: StoredArtifactKind = record.artifact.kind,
): StoredArtifactMetadata => ({
  protocol: "cake.artifact/v1",
  id: record.artifact.id,
  sessionId: record.artifact.sessionId,
  workspacePath: record.workspacePath,
  revision: record.artifact.revision,
  kind,
  digest: record.digest,
  createdAt: record.createdAt,
  updatedAt: record.updatedAt,
});

export const makeArtifactStorageLive = (root: string) =>
  Layer.effect(
    ArtifactStorage,
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const locks = yield* RcMap.make({ lookup: () => Semaphore.make(1) });

      const blobDirectory = path.join(root, "blobs");
      const blobPath = (value: string) => path.join(blobDirectory, `${value}.json`);
      const recordDirectory = (workspacePath: string, sessionId: string) =>
        path.join(root, "sessions", digestKey(workspacePath), digestKey(sessionId));
      const recordPath = (workspacePath: string, sessionId: string, artifactId: string) =>
        path.join(recordDirectory(workspacePath, sessionId), `${digestKey(artifactId)}.json`);

      const readText = (operation: string, file: string) =>
        fileSystem
          .readFileString(file)
          .pipe(Effect.mapError((cause) => storageError(operation, cause)));
      const writeText = (operation: string, file: string, content: string) =>
        atomicWriteFile(fileSystem, path, file, content, (stage, cause) =>
          storageError(`${operation}:${stage}`, cause),
        );
      const withKeyLock = <A, E, R>(key: string, effect: Effect.Effect<A, E, R>) =>
        Effect.scoped(
          Effect.gen(function* () {
            const lock = yield* RcMap.get(locks, key);
            return yield* lock.withPermits(1)(effect);
          }),
        );

      const hydrateStoredRecord = Effect.fn("ArtifactStorage.hydrateStoredRecord")(function* (
        serialized: string,
        metadata: StoredArtifactMetadata,
      ) {
        const actualDigest = digest(serialized);
        if (actualDigest !== metadata.digest)
          return yield* storageError("get", `Artifact ${metadata.id} digest does not match`);
        const decoded = yield* parseJson("decode", serialized).pipe(
          Effect.flatMap(decodeStoredArtifact),
        );
        if (
          decoded.artifact.id !== metadata.id ||
          decoded.artifact.sessionId !== metadata.sessionId ||
          decoded.artifact.revision !== metadata.revision ||
          decoded.storedKind !== metadata.kind
        )
          return yield* storageError(
            "get",
            `Artifact ${metadata.id} metadata does not match its immutable blob`,
          );
        return yield* decodeRecord({
          artifact: decoded.artifact,
          workspacePath: metadata.workspacePath,
          digest: metadata.digest,
          createdAt: metadata.createdAt,
          updatedAt: metadata.updatedAt,
        });
      });

      const get = Effect.fn("ArtifactStorage.get")(function* (
        workspacePath: string,
        sessionId: string,
        artifactId: string,
      ) {
        const indexPath = recordPath(workspacePath, sessionId, artifactId);
        const exists = yield* fileSystem
          .exists(indexPath)
          .pipe(Effect.mapError((cause) => storageError("get", cause)));
        if (!exists) return undefined;
        const metadata = yield* readText("get", indexPath).pipe(
          Effect.flatMap((text) => parseJson("decode", text)),
          Effect.flatMap(decodeMetadata),
        );
        if (metadata.workspacePath !== workspacePath)
          return yield* storageError(
            "get",
            `Artifact ${metadata.id} workspace metadata does not match its index`,
          );
        const serialized = yield* readText("get", blobPath(metadata.digest));
        return yield* hydrateStoredRecord(serialized, metadata);
      });

      const listSession = Effect.fn("ArtifactStorage.listSession")(function* (
        workspacePath: string,
        sessionId: string,
      ) {
        const directory = recordDirectory(workspacePath, sessionId);
        const exists = yield* fileSystem
          .exists(directory)
          .pipe(Effect.mapError((cause) => storageError("listSession", cause)));
        if (!exists) return [];
        const names = yield* fileSystem
          .readDirectory(directory)
          .pipe(Effect.mapError((cause) => storageError("listSession", cause)));
        const records = yield* Effect.forEach(
          names.filter((name) => name.endsWith(".json")),
          (name) =>
            readText("listSession", path.join(directory, name)).pipe(
              Effect.flatMap((text) => parseJson("decode", text)),
              Effect.flatMap(decodeMetadata),
              Effect.flatMap((metadata) => get(workspacePath, sessionId, metadata.id)),
            ),
          { concurrency: "unbounded" },
        );
        return records
          .filter((record): record is ArtifactRecord => record !== undefined)
          .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
      });

      const linkSessionUnlocked = Effect.fn("ArtifactStorage.linkSessionUnlocked")(function* (
        record: ArtifactRecord,
        sessionId: string,
        storedKind: StoredArtifactKind = record.artifact.kind,
      ) {
        const target = recordPath(record.workspacePath, sessionId, record.artifact.id);
        const content = yield* attempt(
          "linkSession",
          () => `${JSON.stringify(toMetadata(record, storedKind), null, 2)}\n`,
        );
        yield* writeText("linkSession", target, content);
      });

      const linkSession = Effect.fn("ArtifactStorage.linkSession")((record, sessionId) => {
        const target = recordPath(record.workspacePath, sessionId, record.artifact.id);
        return withKeyLock(target, linkSessionUnlocked(record, sessionId));
      });

      const upsert = Effect.fn("ArtifactStorage.upsert")(function* <Input>(
        workspacePath: string,
        input: Input,
      ) {
        const artifact = yield* decodeArtifactInput(input);
        const key = recordPath(workspacePath, artifact.sessionId, artifact.id);
        return yield* withKeyLock(
          key,
          Effect.gen(function* () {
            const existing = yield* get(workspacePath, artifact.sessionId, artifact.id);
            if (existing && artifact.revision !== existing.artifact.revision + 1)
              return yield* storageError(
                "upsert",
                `Artifact ${artifact.id} revision must advance from ${existing.artifact.revision} to ${existing.artifact.revision + 1}`,
              );
            if (!existing && artifact.revision !== 1)
              return yield* storageError(
                "upsert",
                `New artifact ${artifact.id} must start at revision 1`,
              );

            const serialized = yield* attempt(
              "upsert",
              () => `${JSON.stringify(artifact, null, 2)}\n`,
            );
            const artifactDigest = digest(serialized);
            const now = DateTime.formatIso(yield* DateTime.now);
            const record = yield* decodeRecord({
              artifact,
              workspacePath,
              digest: artifactDigest,
              createdAt: existing?.createdAt ?? now,
              updatedAt: now,
            });
            yield* fileSystem
              .makeDirectory(blobDirectory, { recursive: true, mode: 0o700 })
              .pipe(Effect.mapError((cause) => storageError("upsert", cause)));
            yield* writeText("upsert", blobPath(artifactDigest), serialized);
            const metadata = yield* attempt(
              "upsert",
              () => `${JSON.stringify(toMetadata(record), null, 2)}\n`,
            );
            yield* writeText("upsert", key, metadata);
            return record;
          }),
        );
      });

      const inheritFork = Effect.fn("ArtifactStorage.inheritFork")(function* (
        sourceWorkspacePath: string,
        sourceSessionId: string,
        destinationWorkspacePath: string,
        destinationSessionId: string,
        pointers: ReadonlyArray<ArtifactPointer>,
      ) {
        const sourceRecords = yield* listSession(sourceWorkspacePath, sourceSessionId);
        const recordsById = new Map(sourceRecords.map((record) => [record.artifact.id, record]));
        const inherited = yield* Effect.forEach(
          pointers,
          Effect.fn("ArtifactStorage.inheritPointer")(function* (pointer) {
            const serialized = yield* readText("inheritFork", blobPath(pointer.digest));
            const actualDigest = digest(serialized);
            const decoded = yield* parseJson("decode", serialized).pipe(
              Effect.flatMap(decodeStoredArtifact),
            );
            if (
              actualDigest !== pointer.digest ||
              decoded.artifact.id !== pointer.artifactId ||
              decoded.artifact.sessionId !== pointer.sessionId ||
              decoded.artifact.revision !== pointer.revision ||
              decoded.storedKind !== pointer.kind
            )
              return yield* storageError(
                "inheritFork",
                `Artifact ${pointer.artifactId} revision ${pointer.revision} does not match its source pointer`,
              );
            const current = recordsById.get(pointer.artifactId);
            if (!current)
              return yield* storageError(
                "inheritFork",
                `Artifact ${pointer.artifactId} is not associated with source session ${sourceSessionId}`,
              );
            const now = DateTime.formatIso(yield* DateTime.now);
            const record = yield* decodeRecord({
              artifact: decoded.artifact,
              workspacePath: destinationWorkspacePath,
              digest: actualDigest,
              createdAt: current.createdAt ?? now,
              updatedAt: current.updatedAt ?? now,
            });
            return { record, storedKind: decoded.storedKind };
          }),
          { concurrency: "unbounded" },
        );
        yield* Effect.forEach(
          inherited,
          ({ record, storedKind }) => {
            const target = recordPath(
              record.workspacePath,
              destinationSessionId,
              record.artifact.id,
            );
            return withKeyLock(
              target,
              linkSessionUnlocked(record, destinationSessionId, storedKind),
            );
          },
          { concurrency: "unbounded", discard: true },
        );
      });

      const deleteSession = Effect.fn("ArtifactStorage.deleteSession")(
        (workspacePath: string, sessionId: string) =>
          fileSystem
            .remove(recordDirectory(workspacePath, sessionId), { recursive: true, force: true })
            .pipe(Effect.mapError((cause) => storageError("deleteSession", cause))),
      );

      const exportMarkdown = Effect.fn("ArtifactStorage.exportMarkdown")(function* (
        workspacePath: string,
        sessionId: string,
      ) {
        const records = yield* listSession(workspacePath, sessionId);
        return records
          .map(
            ({ artifact }) =>
              `## ${artifact.title ?? artifact.id}\n\n${artifact.fallback.markdown}`,
          )
          .join("\n\n---\n\n");
      });

      return ArtifactStorage.of({
        upsert,
        get,
        listSession,
        linkSession,
        inheritFork,
        deleteSession,
        exportMarkdown,
      });
    }),
  );
