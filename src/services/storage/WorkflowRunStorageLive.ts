import { Effect, FileSystem, Layer, Option, Path, Schema, Semaphore } from "effect";
import { WorkflowError, WorkflowRunId } from "../../contracts/workflows/workflow-data";
import { workflowSummary } from "../../contracts/workflows/workflow-projection";
import { WorkflowCheckpoint, WorkflowRunStorage } from "./WorkflowRunStorage";
import { atomicWriteFile } from "./internal/atomicFile";

const Document = Schema.Struct({ version: Schema.Literal(1), checkpoint: WorkflowCheckpoint });
const failure = (operation: string, error: unknown) =>
  new WorkflowError({
    operation,
    reason: "storage",
    message: error instanceof Error ? error.message : String(error),
  });

export const makeWorkflowRunStorageLive = (directory: string) =>
  Layer.effect(
    WorkflowRunStorage,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const lock = yield* Semaphore.make(1);
      const location = (id: WorkflowRunId) => path.join(directory, `${id}.json`);
      const loadUnlocked = Effect.fn("WorkflowRunStorage.loadUnlocked")(function* (
        id: WorkflowRunId,
      ) {
        yield* Schema.decodeUnknownEffect(WorkflowRunId)(id).pipe(
          Effect.mapError((error) => failure("load", error)),
        );
        const target = location(id);
        if (!(yield* fs.exists(target).pipe(Effect.mapError((error) => failure("load", error)))))
          return Option.none();
        const text = yield* fs
          .readFileString(target)
          .pipe(Effect.mapError((error) => failure("load", error)));
        const document = yield* Effect.try({
          try: () => Schema.decodeUnknownSync(Document)(JSON.parse(text)),
          catch: (error) => failure("decode", error),
        });
        if (document.checkpoint.run.id !== id)
          return yield* failure("decode", "Checkpoint identity does not match its filename.");
        return Option.some(document.checkpoint);
      });
      const load = Effect.fn("WorkflowRunStorage.load")((id: WorkflowRunId) =>
        lock.withPermits(1)(loadUnlocked(id)),
      );
      const list = Effect.fn("WorkflowRunStorage.list")(function* (ownerSessionId: string) {
        return yield* lock.withPermits(1)(
          Effect.gen(function* () {
            if (
              !(yield* fs
                .exists(directory)
                .pipe(Effect.mapError((error) => failure("list", error))))
            )
              return [];
            const entries = yield* fs
              .readDirectory(directory)
              .pipe(Effect.mapError((error) => failure("list", error)));
            const result = [];
            for (const file of entries.filter((item) => item.endsWith(".json")).sort()) {
              const id = yield* Schema.decodeUnknownEffect(WorkflowRunId)(file.slice(0, -5)).pipe(
                Effect.mapError((error) => failure("list", error)),
              );
              const loaded = yield* loadUnlocked(id);
              if (Option.isSome(loaded) && loaded.value.run.ownerSessionId === ownerSessionId)
                result.push(workflowSummary(loaded.value.run));
            }
            return result;
          }),
        );
      });
      const save = Effect.fn("WorkflowRunStorage.save")(function* (
        checkpoint: WorkflowCheckpoint,
        expectedRevision: number | null,
      ) {
        yield* lock.withPermits(1)(
          Effect.gen(function* () {
            const encoded = yield* Schema.encodeEffect(Document)({ version: 1, checkpoint }).pipe(
              Effect.mapError((error) => failure("encode", error)),
            );
            const previous = yield* loadUnlocked(checkpoint.run.id);
            if (
              expectedRevision === null
                ? Option.isSome(previous)
                : Option.isNone(previous) || previous.value.run.revision !== expectedRevision
            ) {
              return yield* failure(
                "save",
                "Checkpoint revision conflict; refusing a stale or duplicate write.",
              );
            }
            if (expectedRevision !== null && checkpoint.run.revision !== expectedRevision + 1)
              return yield* failure(
                "save",
                "A checkpoint update must advance its revision exactly once.",
              );
            yield* atomicWriteFile(
              fs,
              path,
              location(checkpoint.run.id),
              `${JSON.stringify(encoded, null, 2)}\n`,
              failure,
            );
          }),
        );
      });
      return WorkflowRunStorage.of({ load, list, save });
    }),
  );
