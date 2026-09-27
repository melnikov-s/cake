import {
  Context,
  Effect,
  FileSystem,
  Layer,
  Path,
  PubSub,
  Schema,
  Semaphore,
  Stream,
} from "effect";
import { SavedDraft } from "../../domain/project-sessions/saved-draft-data";
import { atomicWriteFile } from "./internal/atomicFile";

const Document = Schema.Struct({ version: Schema.Literal(1), records: Schema.Array(SavedDraft) });

export class SavedDraftError extends Schema.TaggedError<SavedDraftError>()("SavedDraftError", {
  operation: Schema.String,
  message: Schema.String,
}) {}
const failure = (operation: string, cause: unknown) =>
  new SavedDraftError({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
  });

export class SavedDraftStorage extends Context.Service<
  SavedDraftStorage,
  {
    readonly list: () => Effect.Effect<ReadonlyArray<SavedDraft>, SavedDraftError>;
    readonly observe: () => Stream.Stream<ReadonlyArray<SavedDraft>, SavedDraftError>;
    readonly create: (record: SavedDraft) => Effect.Effect<SavedDraft, SavedDraftError>;
    readonly update: (
      record: SavedDraft,
      expectedRevision: number,
    ) => Effect.Effect<SavedDraft, SavedDraftError>;
    readonly claim: (
      sessionId: string,
      expectedRevision: number,
      workingDirectory: string,
    ) => Effect.Effect<SavedDraft, SavedDraftError>;
    readonly assignWorkingDirectory: (
      sessionId: string,
      expectedRevision: number,
      workingDirectory: string,
    ) => Effect.Effect<SavedDraft, SavedDraftError>;
    readonly complete: (
      sessionId: string,
      expectedRevision: number,
    ) => Effect.Effect<SavedDraft, SavedDraftError>;
    readonly release: (
      sessionId: string,
      expectedRevision: number,
    ) => Effect.Effect<SavedDraft, SavedDraftError>;
    readonly remove: (
      sessionId: string,
      expectedRevision: number,
    ) => Effect.Effect<void, SavedDraftError>;
  }
>()("cake/services/storage/SavedDraftStorage") {}

/** Single backend process owns the file and serializes all read-modify-write operations. */
export const makeSavedDraftStorageLive = (stateDirectory: string) =>
  Layer.effect(
    SavedDraftStorage,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const file = path.join(stateDirectory, "saved-drafts.json");
      const lock = yield* Semaphore.make(1);
      const changes = yield* PubSub.bounded<ReadonlyArray<SavedDraft>>({ capacity: 1_024 });
      const read = Effect.fn("SavedDraftStorage.read")(function* () {
        if (!(yield* fs.exists(file).pipe(Effect.mapError((cause) => failure("read", cause)))))
          return [];
        const text = yield* fs
          .readFileString(file)
          .pipe(Effect.mapError((cause) => failure("read", cause)));
        const parsed: unknown = yield* Effect.try({
          try: () => JSON.parse(text),
          catch: (cause) => failure("decode", cause),
        });
        return (yield* Schema.decodeUnknownEffect(Document)(parsed).pipe(
          Effect.mapError((cause) => failure("decode", cause)),
        )).records;
      });
      const write = Effect.fn("SavedDraftStorage.write")(function* (
        records: ReadonlyArray<SavedDraft>,
      ) {
        const document = yield* Schema.encodeEffect(Document)({
          version: 1,
          records: [...records],
        }).pipe(Effect.mapError((cause) => failure("encode", cause)));
        yield* atomicWriteFile(
          fs,
          path,
          file,
          `${JSON.stringify(document, null, 2)}\n`,
          (stage, cause) => failure(stage, cause),
        );
        yield* PubSub.publish(changes, [...records]);
      });
      const list = Effect.fn("SavedDraftStorage.list")(() => lock.withPermits(1)(read()));
      const observe = () =>
        Stream.unwrap(
          PubSub.subscribe(changes).pipe(
            Effect.map((subscription) =>
              Stream.fromEffect(list()).pipe(Stream.concat(Stream.fromSubscription(subscription))),
            ),
          ),
        );
      const create = Effect.fn("SavedDraftStorage.create")(function* (record: SavedDraft) {
        return yield* lock.withPermits(1)(
          Effect.gen(function* () {
            const records = yield* read();
            const existing = records.find((item) => item.sessionId === record.sessionId);
            if (existing) {
              // Re-importing a legacy window snapshot never overwrites newer shared revisions.
              if (existing.projectPath === record.projectPath) return existing;
              return yield* failure("create", "Saved Draft identity belongs to another Project");
            }
            yield* write([...records, record]);
            return record;
          }),
        );
      });
      const mutate = Effect.fn("SavedDraftStorage.mutate")(function* (
        sessionId: string,
        expectedRevision: number,
        operation: string,
        change: (record: SavedDraft) => Effect.Effect<SavedDraft | undefined, SavedDraftError>,
      ) {
        return yield* lock.withPermits(1)(
          Effect.gen(function* () {
            const records = yield* read();
            const index = records.findIndex((item) => item.sessionId === sessionId);
            if (index < 0) return yield* failure(operation, "Saved Draft not found");
            const current = records[index]!;
            if (current.revision !== expectedRevision)
              return yield* failure(
                operation,
                `Revision conflict: current revision ${current.revision}`,
              );
            const next = yield* change(current);
            const updated = [...records];
            if (next) updated[index] = next;
            else updated.splice(index, 1);
            yield* write(updated);
            return next;
          }),
        );
      });
      const update = Effect.fn("SavedDraftStorage.update")(function* (
        record: SavedDraft,
        expectedRevision: number,
      ) {
        const updated = yield* mutate(record.sessionId, expectedRevision, "update", (current) =>
          current.status !== "saved" || current.projectPath !== record.projectPath
            ? Effect.fail(failure("update", "Saved Draft is not editable"))
            : Effect.succeed({
                ...record,
                sessionId: current.sessionId,
                createdAt: current.createdAt,
                revision: current.revision + 1,
                status: "saved" as const,
              }),
        );
        if (!updated) return yield* failure("update", "Saved Draft was removed");
        return updated;
      });
      const claim = Effect.fn("SavedDraftStorage.claim")(function* (
        sessionId: string,
        expectedRevision: number,
        workingDirectory: string,
      ) {
        const updated = yield* mutate(sessionId, expectedRevision, "activate", (record) =>
          record.status !== "saved"
            ? Effect.fail(failure("activate", "Saved Draft is already activating or activated"))
            : Effect.succeed({
                ...record,
                revision: record.revision + 1,
                status: "activating" as const,
                workingDirectory,
              }),
        );
        if (!updated) return yield* failure("activate", "Saved Draft was removed");
        return updated;
      });
      const assignWorkingDirectory = Effect.fn("SavedDraftStorage.assignWorkingDirectory")(
        function* (sessionId: string, expectedRevision: number, workingDirectory: string) {
          const updated = yield* mutate(
            sessionId,
            expectedRevision,
            "assignWorkingDirectory",
            (record) =>
              record.status !== "activating"
                ? Effect.fail(failure("assignWorkingDirectory", "Saved Draft is not activating"))
                : Effect.succeed({ ...record, revision: record.revision + 1, workingDirectory }),
          );
          if (!updated) return yield* failure("assignWorkingDirectory", "Saved Draft was removed");
          return updated;
        },
      );
      const complete = Effect.fn("SavedDraftStorage.complete")(function* (
        sessionId: string,
        expectedRevision: number,
      ) {
        const updated = yield* mutate(sessionId, expectedRevision, "complete", (record) =>
          record.status !== "activating"
            ? Effect.fail(failure("complete", "Saved Draft is not activating"))
            : Effect.succeed({
                ...record,
                revision: record.revision + 1,
                status: "activated" as const,
              }),
        );
        if (!updated) return yield* failure("complete", "Saved Draft was removed");
        return updated;
      });
      const release = Effect.fn("SavedDraftStorage.release")(function* (
        sessionId: string,
        expectedRevision: number,
      ) {
        const updated = yield* mutate(sessionId, expectedRevision, "release", (record) =>
          record.status !== "activating"
            ? Effect.fail(failure("release", "Saved Draft is not activating"))
            : Effect.succeed({
                ...record,
                revision: record.revision + 1,
                status: "saved" as const,
                workingDirectory: record.projectPath,
              }),
        );
        if (!updated) return yield* failure("release", "Saved Draft was removed");
        return updated;
      });
      const remove = Effect.fn("SavedDraftStorage.remove")(
        (sessionId: string, expectedRevision: number) =>
          mutate(sessionId, expectedRevision, "remove", (record) =>
            record.status !== "saved"
              ? Effect.fail(failure("remove", "Saved Draft has already started"))
              : Effect.succeed(undefined),
          ).pipe(Effect.asVoid),
      );
      return SavedDraftStorage.of({
        list,
        observe,
        create,
        update,
        claim,
        assignWorkingDirectory,
        complete,
        release,
        remove,
      });
    }),
  );
