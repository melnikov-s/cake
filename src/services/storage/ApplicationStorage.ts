import { Context, Effect, FileSystem, Layer, Path, Schema, Semaphore, Struct } from "effect";
import { randomUUID } from "node:crypto";
import { ProjectTodo, ProjectTodos } from "../../contracts/projects/project-todos";
import { clearProjectTodoSelection } from "../../utils/project-todo-selection";
import {
  ApplicationState,
  CakeChatPreferences,
  ModelPreset,
  ProjectRecord,
  ProjectSettings,
  ProjectWorkflowSessionDetails,
  SessionLabel,
  SessionLabelColor,
  UtilityModel,
  defaultApplicationState,
  type ApplicationState as ApplicationStateValue,
} from "../../contracts/application/application-data";
import { CakePrompts } from "../../contracts/application/cake-prompt-data";
import versionFivePromptDefaults from "./internal/application-v5-prompt-defaults.json";
import { atomicWriteFile, type AtomicFileStage } from "./internal/atomicFile";
import {
  ApplicationEncodeError,
  ApplicationWriteError,
} from "../../contracts/storage/application-storage-errors";

const APPLICATION_DOCUMENT_VERSION = 9;
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

const LegacySessionLabel = Schema.Struct({
  id: Schema.String.check(Schema.isUUID(4)),
  name: Schema.String,
  color: SessionLabelColor,
});
const LegacyProjectWorkflow = Schema.Struct({
  columns: Schema.Array(LegacySessionLabel),
  assignments: Schema.Array(
    Schema.Struct({ sessionId: Schema.String, statusId: Schema.String.check(Schema.isUUID(4)) }),
  ),
  sessionDetails: Schema.Array(ProjectWorkflowSessionDetails),
});
const LegacyProjectRecord = Schema.Struct({
  path: Schema.String,
  name: Schema.String,
  addedAt: Schema.String,
  lastOpenedAt: Schema.String,
  settings: Schema.optionalKey(ProjectSettings),
  workflow: Schema.optionalKey(LegacyProjectWorkflow),
});

const LegacyApplicationState = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  projects: Schema.optionalKey(Schema.Array(LegacyProjectRecord)),
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
  projects: Schema.Array(LegacyProjectRecord),
  unreadSessionIds: Schema.Array(Schema.String),
  trustedProjectPaths: Schema.Array(Schema.String),
  fastModeSessionIds: Schema.Array(Schema.String),
  utilityModel: Schema.optionalKey(UtilityModel),
  vscodeServerPath: Schema.optionalKey(Schema.String),
  modelPresets: Schema.Array(ModelPreset),
  defaultModelPresetId: Schema.optionalKey(Schema.String),
});
type ApplicationStateV1 = typeof ApplicationStateV1.Type;

const ApplicationStateV2 = Schema.Struct({
  projects: Schema.Array(LegacyProjectRecord),
  globalWorkflowStatuses: Schema.Array(LegacySessionLabel),
  unreadSessionIds: Schema.Array(Schema.String),
  trustedProjectPaths: Schema.Array(Schema.String),
  fastModeSessionIds: Schema.Array(Schema.String),
  utilityModel: Schema.optionalKey(UtilityModel),
  vscodeServerPath: Schema.optionalKey(Schema.String),
  modelPresets: Schema.Array(ModelPreset),
  defaultModelPresetId: Schema.optionalKey(Schema.String),
});
type ApplicationStateV2 = typeof ApplicationStateV2.Type;

const ProjectTodoV8 = Schema.Struct(Struct.omit(ProjectTodo.fields, ["description"]));
const ProjectRecordV8 = Schema.Struct({
  ...ProjectRecord.fields,
  todos: Schema.optionalKey(
    Schema.Struct({
      ...ProjectTodos.fields,
      items: Schema.Array(ProjectTodoV8).check(Schema.isMaxLength(1000)),
    }),
  ),
});
const ApplicationStateV8 = Schema.Struct({
  ...ApplicationState.fields,
  projects: Schema.Array(ProjectRecordV8),
});
type ApplicationStateV8 = typeof ApplicationStateV8.Type;

const ApplicationStateV3 = Schema.Struct({
  projects: Schema.Array(ProjectRecordV8),
  globalSessionLabels: Schema.Array(SessionLabel),
  unreadSessionIds: Schema.Array(Schema.String),
  trustedProjectPaths: Schema.Array(Schema.String),
  fastModeSessionIds: Schema.Array(Schema.String),
  utilityModel: Schema.optionalKey(UtilityModel),
  vscodeServerPath: Schema.optionalKey(Schema.String),
  modelPresets: Schema.Array(ModelPreset),
  defaultModelPresetId: Schema.optionalKey(Schema.String),
});
type ApplicationStateV3 = typeof ApplicationStateV3.Type;

const ApplicationStateV4 = Schema.Struct({
  ...ApplicationStateV3.fields,
  sessionPlugins: ApplicationState.fields.sessionPlugins,
  sessionPluginSharedState: ApplicationState.fields.sessionPluginSharedState,
});
type ApplicationStateV4 = typeof ApplicationStateV4.Type;

// Versions five and six stored the Cake Chat summarization model as a bare utility-style
// model; version seven stores a model choice shared with the Subagent default model.
const ApplicationStateV6 = Schema.Struct({
  ...ApplicationStateV8.fields,
  cakeChatPreferences: Schema.optionalKey(
    Schema.Struct({
      ...CakeChatPreferences.fields,
      summarizationModel: Schema.optionalKey(UtilityModel),
    }),
  ),
});
type ApplicationStateV6 = typeof ApplicationStateV6.Type;

const ApplicationStateV5 = Schema.Struct({
  ...ApplicationStateV6.fields,
  cakePrompts: CakePrompts,
});
type ApplicationStateV5 = typeof ApplicationStateV5.Type;

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
  const globalWorkflowStatuses = [
    { id: "00000000-0000-4000-8000-000000000001", name: "Feature", color: "blue" as const },
    { id: "00000000-0000-4000-8000-000000000002", name: "Bug", color: "rose" as const },
    { id: "00000000-0000-4000-8000-000000000003", name: "Research", color: "violet" as const },
    { id: "00000000-0000-4000-8000-000000000004", name: "Chore", color: "amber" as const },
  ];
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

const migrateVersionTwo = Effect.fn("ApplicationStorage.migrateVersionTwo")((
  state: ApplicationStateV2,
) => {
  const { globalWorkflowStatuses: globalSessionLabels, ...rest } = state;
  const projects = state.projects.map((project) =>
    project.workflow
      ? {
          ...project,
          workflow: {
            labels: project.workflow.columns,
            assignments: project.workflow.assignments.map((assignment) => ({
              sessionId: assignment.sessionId,
              labelIds: [assignment.statusId],
            })),
            sessionDetails: project.workflow.sessionDetails,
          },
        }
      : project,
  );
  return Effect.succeed({ ...rest, projects, globalSessionLabels });
});

const migrateVersionThree = Effect.fn("ApplicationStorage.migrateVersionThree")(
  (state: ApplicationStateV3) =>
    Effect.succeed({ ...state, sessionPlugins: [], sessionPluginSharedState: [] }),
);

const migrateVersionFour = Effect.fn("ApplicationStorage.migrateVersionFour")(
  (state: ApplicationStateV4) =>
    Effect.succeed({ ...state, cakePrompts: versionFivePromptDefaults }),
);

// Version five stored copies of defaults, so remove known shipped wording while
// retaining custom text. Version six stores only overrides and never copies defaults.
const migrateVersionFive = Effect.fn("ApplicationStorage.migrateVersionFive")((
  state: ApplicationStateV5,
) => {
  const prompts: { -readonly [Key in keyof CakePrompts]?: string } = {};
  const oldCommitDefault = [
    "Cake is preparing to merge this worktree into {{target}}, but it has uncommitted changes.",
    "",
    "Inspect the complete working tree, verify the change, and commit all intended work with an appropriate commit message.",
    "",
    "Do not merge, rebase, push, switch branches, or modify the target checkout. Cake will merge the committed branch after this turn finishes.",
  ].join("\n");
  // SAFETY: the decoded version-five schema has exactly these declared prompt keys.
  for (const key of Object.keys(CakePrompts.fields) as Array<keyof CakePrompts>) {
    const value = state.cakePrompts[key];
    if (
      value.trim() &&
      value !== versionFivePromptDefaults[key] &&
      !(key === "worktreeCommit" && value === oldCommitDefault)
    )
      prompts[key] = value;
  }
  return Effect.succeed({ ...state, cakePrompts: prompts });
});

// A stored summarization override becomes an explicit model choice with Fast mode off, which
// is how summaries already ran; an absent value keeps meaning the utility model.
const migrateVersionSix = Effect.fn("ApplicationStorage.migrateVersionSix")((
  state: ApplicationStateV6,
) => {
  const { cakeChatPreferences, ...rest } = state;
  if (!cakeChatPreferences) return Effect.succeed<ApplicationStateV8>(rest);
  const { summarizationModel, ...preferences } = cakeChatPreferences;
  return Effect.succeed<ApplicationStateV8>({
    ...rest,
    cakeChatPreferences: summarizationModel
      ? {
          ...preferences,
          summarizationModel: {
            source: "model",
            model: { ...summarizationModel, fastMode: false },
          },
        }
      : preferences,
  });
});

// Restore the deliberately small view after the shipped default was raised.
// v7 stored no provenance: explicit 128k and a copied default are indistinguishable.
// Preserve every other budget/field; v8 saves may explicitly select 128k again.
const migrateVersionSeven = Effect.fn("ApplicationStorage.migrateVersionSeven")(
  (state: ApplicationStateV8) =>
    Effect.succeed<ApplicationStateV8>(
      state.cakeChatPreferences?.memoryViewBytes === 128_000
        ? {
            ...state,
            cakeChatPreferences: { ...state.cakeChatPreferences, memoryViewBytes: 40_000 },
          }
        : state,
    ),
);

const migrateVersionEight = Effect.fn("ApplicationStorage.migrateVersionEight")(
  (state: ApplicationStateV8) =>
    Effect.succeed({
      ...state,
      projects: state.projects.map((project) =>
        project.todos
          ? {
              ...project,
              todos: {
                ...project.todos,
                items: project.todos.items.map((item) => ({
                  ...item,
                  description: item.status.trim().slice(0, 2048).trim() || item.title,
                })),
              },
            }
          : project,
      ),
    }),
);

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
          } else if (version === 2) {
            const previous = yield* Schema.decodeUnknownEffect(ApplicationStateV2)(data).pipe(
              Effect.mapError(
                (cause) =>
                  new ApplicationMigrationError({
                    fromVersion: 2,
                    message: cause.message,
                  }),
              ),
            );
            data = yield* migrateVersionTwo(previous);
          } else if (version === 3) {
            const previous = yield* Schema.decodeUnknownEffect(ApplicationStateV3)(data).pipe(
              Effect.mapError(
                (cause) =>
                  new ApplicationMigrationError({
                    fromVersion: 3,
                    message: cause.message,
                  }),
              ),
            );
            data = yield* migrateVersionThree(previous);
          } else if (version === 4) {
            const previous = yield* Schema.decodeUnknownEffect(ApplicationStateV4)(data).pipe(
              Effect.mapError(
                (cause) =>
                  new ApplicationMigrationError({
                    fromVersion: 4,
                    message: cause.message,
                  }),
              ),
            );
            data = yield* migrateVersionFour(previous);
          } else if (version === 5) {
            const previous = yield* Schema.decodeUnknownEffect(ApplicationStateV5)(data).pipe(
              Effect.mapError(
                (cause) =>
                  new ApplicationMigrationError({
                    fromVersion: 5,
                    message: cause.message,
                  }),
              ),
            );
            data = yield* migrateVersionFive(previous);
          } else if (version === 6) {
            const previous = yield* Schema.decodeUnknownEffect(ApplicationStateV6)(data).pipe(
              Effect.mapError(
                (cause) =>
                  new ApplicationMigrationError({
                    fromVersion: 6,
                    message: cause.message,
                  }),
              ),
            );
            data = yield* migrateVersionSix(previous);
          } else if (version === 7) {
            const previous = yield* Schema.decodeUnknownEffect(ApplicationStateV8)(data).pipe(
              Effect.mapError(
                (cause) =>
                  new ApplicationMigrationError({
                    fromVersion: 7,
                    message: cause.message,
                  }),
              ),
            );
            data = yield* migrateVersionSeven(previous);
          } else if (version === 8) {
            const previous = yield* Schema.decodeUnknownEffect(ApplicationStateV8)(data).pipe(
              Effect.mapError(
                (cause) =>
                  new ApplicationMigrationError({ fromVersion: 8, message: cause.message }),
              ),
            );
            data = yield* migrateVersionEight(previous);
          } else
            return yield* new ApplicationMigrationError({
              fromVersion: version,
              message: "No sequential Application document migration is registered",
            });
          version += 1;
          migrated = true;
        }

        const decoded = yield* Schema.decodeUnknownEffect(ApplicationState)(data).pipe(
          Effect.mapError((cause) => new ApplicationDecodeError({ message: cause.message })),
        );
        let repaired = false;
        // A selection lives only while a to-do panel is open, and none is open at startup.
        const cakeChatTodos =
          decoded.cakeChatTodos && clearProjectTodoSelection(decoded.cakeChatTodos, randomUUID);
        if (cakeChatTodos !== decoded.cakeChatTodos) repaired = true;
        const state = {
          ...decoded,
          ...(cakeChatTodos ? { cakeChatTodos } : null),
          projects: decoded.projects.map((project) => {
            if (!project.todos) return project;
            // A selection lives only while a to-do panel is open, and none is open at startup.
            const todos = clearProjectTodoSelection(project.todos, randomUUID);
            if (todos === project.todos) return project;
            repaired = true;
            return { ...project, todos };
          }),
        };
        if (migrated || repaired) yield* saveUnlocked(state);
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
