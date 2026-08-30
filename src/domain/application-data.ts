import { Schema } from "effect";

const boundedString = (maximum: number) => Schema.String.check(Schema.isMaxLength(maximum));
const nonEmptyBoundedString = (maximum: number) =>
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(maximum));
const boundedArray = <S extends Schema.Top>(item: S, maximum: number) =>
  Schema.Array(item).check(Schema.isMaxLength(maximum));

const ThinkingLevel = Schema.Literals(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export const UtilityModel = Schema.Struct({
  provider: nonEmptyBoundedString(256),
  modelId: nonEmptyBoundedString(512),
  thinkingLevel: ThinkingLevel,
});

export const ModelPreset = Schema.Struct({
  id: Schema.String.check(Schema.isUUID(4)),
  name: Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(80)),
  provider: nonEmptyBoundedString(256),
  modelId: nonEmptyBoundedString(512),
  thinkingLevel: ThinkingLevel,
  fastMode: Schema.Boolean,
});

const IsoTimestamp = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/),
);

export const ProjectRecord = Schema.Struct({
  path: nonEmptyBoundedString(4_096),
  name: nonEmptyBoundedString(512),
  addedAt: IsoTimestamp,
  lastOpenedAt: IsoTimestamp,
});

const SessionIds = boundedArray(boundedString(256), 10_000).check(Schema.isUnique());

/** Current main-owned Application value. Storage envelope versioning is separate. */
export const ApplicationState = Schema.Struct({
  projects: boundedArray(ProjectRecord, 200),
  resolvedSessionIds: SessionIds,
  resolvedCakeChatSessionIds: SessionIds,
  unreadSessionIds: SessionIds,
  trustedProjectPaths: boundedArray(boundedString(4_096), 200).check(Schema.isUnique()),
  fastModeSessionIds: SessionIds,
  utilityModel: Schema.optional(UtilityModel),
  modelPresets: boundedArray(ModelPreset, 100),
  defaultModelPresetId: Schema.optional(Schema.String.check(Schema.isUUID(4))),
  vscodeServerPath: Schema.optional(boundedString(4_096)),
}).check(
  Schema.makeFilter(
    (state) => {
      const projectPaths = state.projects.map((project) => project.path);
      const presetIds = state.modelPresets.map((preset) => preset.id);
      return (
        new Set(projectPaths).size === projectPaths.length &&
        new Set(presetIds).size === presetIds.length &&
        (state.defaultModelPresetId === undefined || presetIds.includes(state.defaultModelPresetId))
      );
    },
    { expected: "unique Project and Model Preset identities with a valid default preset" },
  ),
);

export type ApplicationState = typeof ApplicationState.Type;
export type ProjectRecord = typeof ProjectRecord.Type;
export type UtilityModel = typeof UtilityModel.Type;
export type ModelPreset = typeof ModelPreset.Type;

export const defaultApplicationState = (): ApplicationState => ({
  projects: [],
  resolvedSessionIds: [],
  resolvedCakeChatSessionIds: [],
  unreadSessionIds: [],
  trustedProjectPaths: [],
  fastModeSessionIds: [],
  modelPresets: [],
});
