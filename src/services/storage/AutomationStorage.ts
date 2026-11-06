import { Context, Effect, FileSystem, Layer, Path, Schema, Semaphore } from "effect";
import {
  Automation,
  AutomationError,
  AutomationOccurrence,
  AutomationRun,
} from "../../contracts/automations/automation-data";
import { ArtifactSchedule } from "../../contracts/artifacts/artifact-schedules";
import { ArtifactLineageId } from "../../contracts/artifacts/artifact-lineage";
import { atomicWriteFile } from "./internal/atomicFile";

/** Workflow metadata only. Session transcripts and resolution retain their existing authorities. */
const SessionAutomationLedger = Schema.Struct({
  automations: Schema.Array(Automation),
  occurrences: Schema.Array(AutomationOccurrence),
  runs: Schema.Array(AutomationRun),
});

export const AutomationLedger = Schema.Struct({
  ...SessionAutomationLedger.fields,
  artifactSchedules: Schema.Array(ArtifactSchedule),
  pausedArtifactIds: Schema.Array(ArtifactLineageId),
});
export interface AutomationLedger extends Schema.Schema.Type<typeof AutomationLedger> {}

export class AutomationStorage extends Context.Service<
  AutomationStorage,
  {
    readonly load: () => Effect.Effect<AutomationLedger, AutomationError>;
    readonly save: (ledger: AutomationLedger) => Effect.Effect<void, AutomationError>;
  }
>()("cake/services/storage/AutomationStorage") {}

const StoredDocument = Schema.Struct({ version: Schema.Literal(2), data: AutomationLedger });
const ReadDocument = Schema.Union([
  Schema.Struct({ version: Schema.Literal(1), data: SessionAutomationLedger }),
  StoredDocument,
]);
const storageError = (operation: string, cause: unknown) =>
  new AutomationError({
    operation,
    code: "unavailable",
    message: cause instanceof Error ? cause.message : String(cause),
  });

export const makeAutomationStorageLive = (stateDirectory: string) =>
  Layer.effect(
    AutomationStorage,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const document = path.join(stateDirectory, "automations.json");
      const lock = yield* Semaphore.make(1);
      const load = Effect.fn("AutomationStorage.load")(function* () {
        if (
          !(yield* fs
            .exists(document)
            .pipe(Effect.mapError((cause) => storageError("load", cause))))
        )
          return {
            automations: [],
            occurrences: [],
            runs: [],
            artifactSchedules: [],
            pausedArtifactIds: [],
          };
        const text = yield* fs
          .readFileString(document)
          .pipe(Effect.mapError((cause) => storageError("load", cause)));
        const stored = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ReadDocument))(
          text,
        ).pipe(Effect.mapError((cause) => storageError("decode", cause)));
        return stored.version === 1
          ? { ...stored.data, artifactSchedules: [], pausedArtifactIds: [] }
          : stored.data;
      }, lock.withPermits(1));
      const save = Effect.fn("AutomationStorage.save")(function* (ledger: AutomationLedger) {
        const encoded = yield* Schema.encodeEffect(StoredDocument)({
          version: 2,
          data: ledger,
        }).pipe(Effect.mapError((cause) => storageError("encode", cause)));
        yield* atomicWriteFile(
          fs,
          path,
          document,
          `${JSON.stringify(encoded, null, 2)}\n`,
          (stage, cause) => storageError(stage, cause),
        );
      }, lock.withPermits(1));
      return AutomationStorage.of({ load, save });
    }),
  );
