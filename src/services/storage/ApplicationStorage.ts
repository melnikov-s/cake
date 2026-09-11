import { Context, Effect, FileSystem, Layer, Path, Schema, Semaphore } from "effect";
import {
  ApplicationState,
  ModelPreset,
  ProjectRecord,
  UtilityModel,
  defaultApplicationState,
  defaultGlobalWorkflowStatuses,
  type ApplicationState as ApplicationStateValue,
} from "../../domain/application/application-data";
import { atomicWriteFile, type AtomicFileStage } from "./internal/atomicFile";

const APPLICATION_DOCUMENT_VERSION = 2;
export const APPLICATION_DOCUMENT_NAME = "application.json";

class ApplicationReadError extends Schema.TaggedError<ApplicationReadError>()(
  "ApplicationReadError",
  { message: Schema.String },
) {}

export class ApplicationMalformedDocumentError extends Schema.TaggedError<ApplicationMalformedDocumentError>()(
  "ApplicationMalformedDocumentError",
  { reason: Schema.Literals(["json", "envelope"]), message: Schema.String },
) {}

export class ApplicationUnsupportedVersionError extends Schema.TaggedError<ApplicationUnsupportedVersionError>()(
  "ApplicationUnsupportedVersionError",
  { version: Schema.Int, currentVersion: Schema.Int },
) {}

export class ApplicationMigrationError extends Schema.TaggedError<ApplicationMigrationError>()(
  "ApplicationMigrationError",
  { fromVersion: Schema.Int, message: Schema.String },
) {}

export class ApplicationDecodeError extends Schema.TaggedError<ApplicationDecodeError>()(
  "ApplicationDecodeError",
  { message: Schema.String },
) {}

export class ApplicationEncodeError extends Schema.TaggedError<ApplicationEncodeError>()(
  "ApplicationEncodeError",
  { message: Schema.String },
) {}

export class ApplicationWriteError extends Schema.TaggedError<ApplicationWriteError>()(
  "ApplicationWriteError",
  { stage: Schema.Literals(["write", "rename"]), message: Schema.String },
) {}

export type ApplicationStorageError =
  | ApplicationReadError
  | ApplicationMalformedDocumentError
  | ApplicationUnsupportedVersionError
  | ApplicationMigrationError
  | ApplicationDecodeError
  | ApplicationEncodeError
  | ApplicationWriteError;

export const ApplicationLoadResult = Schema.Struct({
  state: ApplicationState,
  source: Schema.Literals(["missing", "current", "migrated"]),
});

export interface ApplicationLoadResult extends Schema.Schema.Type<typeof ApplicationLoadResult> {}

export class ApplicationStorage extends Context.Service<
  ApplicationStorage,
  {
    readonly load: () => Effect.Effect<ApplicationLoadResult, ApplicationStorageError>;
    readonly save: (
      state: ApplicationStateValue,
    ) => Effect.Effect<void, ApplicationEncodeError | ApplicationWriteError>;
  }
>()("cake/services/storage/ApplicationStorage") {}

const StoredEnvelope = Schema.Struct({
  version: Schema.Int,
  data: Schema.Unknown,
});

const LegacyApplicationState = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  projects: Schema.optionalKey(Schema.Array(ProjectRecord)),
  resolvedSessionIds: Schema.optionalKey(Schema.Array(Schema.String)),
  unreadSessionIds: Schema.optionalKey(Schema.Array(Schema.String)),
  trustedProjectPaths: Schema.optionalKey(Schema.Array(Schema.String)),
  fastModeSessionIds: Schema.optionalKey(Schema.Array(Schema.String)),
  utilityModel: Schema.optionalKey(UtilityModel),
  modelPresets: Schema.optionalKey(Schema.Array(ModelPreset)),
  defaultModelPresetId: Schema.optionalKey(Schema.String),
  vscodeServerPath: Schema.optionalKey(Schema.String),
});

type LegacyApplicationState = typeof LegacyApplicationState.Type;

const ApplicationStateV1 = Schema.Struct({
  projects: Schema.Array(ProjectRecord),
  unreadSessionIds: Schema.Array(Schema.String),
  trustedProjectPaths: Schema.Array(Schema.String),
  fastModeSessionIds: Schema.Array(Schema.String),
  utilityModel: Schema.optionalKey(UtilityModel),
  vscodeServerPath: Schema.optionalKey(Schema.String),
  modelPresets: Schema.Array(ModelPreset),
  defaultModelPresetId: Schema.optionalKey(Schema.String),
});
type ApplicationStateV1 = typeof ApplicationStateV1.Type;

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const dedupe = <A>(values: ReadonlyArray<A>): ReadonlyArray<A> => [...new Set(values)];

const migrateVersionZero = Effect.fn("ApplicationStorage.migrateVersionZero")((
  legacy: LegacyApplicationState,
) => {
  const projects = Array.from(
    new Map((legacy.projects ?? []).map((project) => [project.path, project])).values(),
  );
  const modelPresets = Array.from(
    new Map((legacy.modelPresets ?? []).map((preset) => [preset.id, preset])).values(),
  );
  const defaultModelPresetId = modelPresets.some(
    (preset) => preset.id === legacy.defaultModelPresetId,
  )
    ? legacy.defaultModelPresetId
    : undefined;
  const vscodeServerPath = legacy.vscodeServerPath?.trim() || undefined;
  const base: ApplicationStateV1 = {
    projects,
    unreadSessionIds: dedupe(legacy.unreadSessionIds ?? []),
    trustedProjectPaths: dedupe(legacy.trustedProjectPaths ?? []),
    fastModeSessionIds: dedupe(legacy.fastModeSessionIds ?? []),
    modelPresets,
  };
  const withUtility =
    legacy.utilityModel === undefined ? base : { ...base, utilityModel: legacy.utilityModel };
  const withDefault =
    defaultModelPresetId === undefined ? withUtility : { ...withUtility, defaultModelPresetId };
  return Effect.succeed(
    vscodeServerPath === undefined ? withDefault : { ...withDefault, vscodeServerPath },
  );
});

const migrateVersionOne = Effect.fn("ApplicationStorage.migrateVersionOne")((
  state: ApplicationStateV1,
) => {
  const globalWorkflowStatuses = [...defaultGlobalWorkflowStatuses()];
  const globalByName = new Map(
    globalWorkflowStatuses.map((status) => [status.name.toLocaleLowerCase(), status]),
  );
  const globalIds = new Set(globalWorkflowStatuses.map((status) => status.id));
  const projects = state.projects.map((project) => {
    if (!project.workflow) return project;
    const remappedIds = new Map<string, string>();
    const columns = project.workflow.columns.flatMap((status) => {
      const globalStatus = globalByName.get(status.name.toLocaleLowerCase());
      if (globalStatus) {
        remappedIds.set(status.id, globalStatus.id);
        return [];
      }
      if (!globalIds.has(status.id)) return [status];
      const id = crypto.randomUUID();
      remappedIds.set(status.id, id);
      return [{ ...status, id }];
    });
    return {
      ...project,
      workflow: {
        ...project.workflow,
        columns,
        assignments: project.workflow.assignments.map((assignment) => ({
          ...assignment,
          statusId: remappedIds.get(assignment.statusId) ?? assignment.statusId,
        })),
      },
    };
  });
  return Effect.succeed({ ...state, projects, globalWorkflowStatuses });
});

const writeError = (stage: AtomicFileStage, cause: unknown) =>
  new ApplicationWriteError({ stage, message: messageOf(cause) });

export const makeApplicationStorageLive = (userDataDirectory: string) =>
  Layer.effect(
    ApplicationStorage,
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const documentPath = path.join(userDataDirectory, APPLICATION_DOCUMENT_NAME);
      const lock = yield* Semaphore.make(1);

      const saveUnlocked = Effect.fn("ApplicationStorage.save")(function* (
        state: ApplicationStateValue,
      ) {
        const data = yield* Schema.encodeEffect(ApplicationState)(state).pipe(
          Effect.mapError((cause) => new ApplicationEncodeError({ message: cause.message })),
        );
        const content = yield* Effect.try({
          try: () =>
            `${JSON.stringify({ version: APPLICATION_DOCUMENT_VERSION, data }, null, 2)}\n`,
          catch: (cause) => new ApplicationEncodeError({ message: messageOf(cause) }),
        });
        yield* atomicWriteFile(fileSystem, path, documentPath, content, writeError);
      });

      const loadUnlocked = Effect.fn("ApplicationStorage.load")(function* () {
        const exists = yield* fileSystem
          .exists(documentPath)
          .pipe(Effect.mapError((cause) => new ApplicationReadError({ message: cause.message })));
        if (!exists) return { state: defaultApplicationState(), source: "missing" as const };

        const text = yield* fileSystem
          .readFileString(documentPath)
          .pipe(Effect.mapError((cause) => new ApplicationReadError({ message: cause.message })));
        const parsed: unknown = yield* Effect.try({
          try: () => JSON.parse(text),
          catch: (cause) =>
            new ApplicationMalformedDocumentError({ reason: "json", message: messageOf(cause) }),
        });

        const envelopeResult = yield* Effect.result(
          Schema.decodeUnknownEffect(StoredEnvelope)(parsed),
        );
        let version: number;
        let data: unknown;
        let migrated = false;
        if (envelopeResult._tag === "Success") {
          version = envelopeResult.success.version;
          data = envelopeResult.success.data;
        } else {
          const legacyResult = yield* Effect.result(
            Schema.decodeUnknownEffect(LegacyApplicationState)(parsed),
          );
          if (legacyResult._tag === "Failure")
            return yield* new ApplicationMalformedDocumentError({
              reason: "envelope",
              message: envelopeResult.failure.message,
            });
          version = 0;
          data = legacyResult.success;
          migrated = true;
        }

        if (version > APPLICATION_DOCUMENT_VERSION)
          return yield* new ApplicationUnsupportedVersionError({
            version,
            currentVersion: APPLICATION_DOCUMENT_VERSION,
          });
        if (version < 0)
          return yield* new ApplicationMigrationError({
            fromVersion: version,
            message: "Application document versions cannot be negative",
          });

        while (version < APPLICATION_DOCUMENT_VERSION) {
          if (version === 0) {
            const legacy = yield* Schema.decodeUnknownEffect(LegacyApplicationState)(data).pipe(
              Effect.mapError(
                (cause) =>
                  new ApplicationMigrationError({
                    fromVersion: 0,
                    message: cause.message,
                  }),
              ),
            );
            data = yield* migrateVersionZero(legacy);
          } else if (version === 1) {
            const previous = yield* Schema.decodeUnknownEffect(ApplicationStateV1)(data).pipe(
              Effect.mapError(
                (cause) =>
                  new ApplicationMigrationError({
                    fromVersion: 1,
                    message: cause.message,
                  }),
              ),
            );
            data = yield* migrateVersionOne(previous);
          } else
            return yield* new ApplicationMigrationError({
              fromVersion: version,
              message: "No sequential Application document migration is registered",
            });
          version += 1;
          migrated = true;
        }

        const state = yield* Schema.decodeUnknownEffect(ApplicationState)(data).pipe(
          Effect.mapError((cause) => new ApplicationDecodeError({ message: cause.message })),
        );
        if (migrated) yield* saveUnlocked(state);
        return { state, source: migrated ? ("migrated" as const) : ("current" as const) };
      });

      const load = Effect.fn("ApplicationStorage.loadSerialized")(function* () {
        return yield* lock.withPermits(1)(loadUnlocked());
      });
      const save = Effect.fn("ApplicationStorage.saveSerialized")(function* (
        state: ApplicationStateValue,
      ) {
        return yield* lock.withPermits(1)(saveUnlocked(state));
      });

      return ApplicationStorage.of({ load, save });
    }),
  );
