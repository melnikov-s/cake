import { Schema } from "effect";
import { ThinkingLevel } from "../services/pi/model-data";

const boundedString = (maximum: number) => Schema.String.check(Schema.isMaxLength(maximum));
const nonEmptyBoundedString = (maximum: number) =>
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(maximum));
const boundedArray = <S extends Schema.Top>(item: S, maximum: number) =>
  Schema.Array(item).check(Schema.isMaxLength(maximum));

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

const DEFAULT_WORKTREE_CREATE_COMMAND =
  "git worktree add -b {branchName} {worktreePath} {baseCommit}";

export const ProjectSettings = Schema.Struct({
  worktreeCreateCommand: boundedString(16_384),
  worktreeSetupCommands: boundedString(65_536),
});

export interface ProjectSettings extends Schema.Schema.Type<typeof ProjectSettings> {}

export const ProjectWorkflowColor = Schema.Literals([
  "rose",
  "peach",
  "amber",
  "lime",
  "mint",
  "sky",
  "blue",
  "violet",
]);
export type ProjectWorkflowColor = typeof ProjectWorkflowColor.Type;

export const PROJECT_WORKFLOW_SESSION_DESCRIPTION_MAX_LENGTH = 560;

const ProjectWorkflowColumn = Schema.Struct({
  id: Schema.String.check(Schema.isUUID(4)),
  name: Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(40)),
  color: ProjectWorkflowColor,
});
const ProjectWorkflowAssignment = Schema.Struct({
  sessionId: nonEmptyBoundedString(256),
  statusId: Schema.String.check(Schema.isUUID(4)),
});
export const ProjectWorkflowSessionDetails = Schema.Struct({
  sessionId: nonEmptyBoundedString(256),
  model: Schema.optionalKey(
    Schema.Struct({
      provider: nonEmptyBoundedString(256),
      modelId: nonEmptyBoundedString(512),
      name: Schema.optionalKey(nonEmptyBoundedString(1_024)),
    }),
  ),
  description: Schema.optionalKey(
    Schema.String.check(
      Schema.isTrimmed(),
      Schema.isMinLength(1),
      Schema.isMaxLength(PROJECT_WORKFLOW_SESSION_DESCRIPTION_MAX_LENGTH),
    ),
  ),
});
export interface ProjectWorkflowSessionDetails extends Schema.Schema.Type<
  typeof ProjectWorkflowSessionDetails
> {}

export const ProjectWorkflow = Schema.Struct({
  columns: boundedArray(ProjectWorkflowColumn, 20),
  assignments: boundedArray(ProjectWorkflowAssignment, 10_000),
  sessionDetails: boundedArray(ProjectWorkflowSessionDetails, 10_000),
}).check(
  Schema.makeFilter(
    (workflow) => {
      const ids = workflow.columns.map((column) => column.id);
      const names = workflow.columns.map((column) => column.name.toLowerCase());
      const reserved = new Set(["draft", "active", "resolved"]);
      return (
        new Set(ids).size === ids.length &&
        new Set(names).size === names.length &&
        names.every((name) => !reserved.has(name)) &&
        new Set(workflow.assignments.map((assignment) => assignment.sessionId)).size ===
          workflow.assignments.length &&
        new Set(workflow.sessionDetails.map((details) => details.sessionId)).size ===
          workflow.sessionDetails.length
      );
    },
    { expected: "a valid project workflow with unique columns and session records" },
  ),
);
export interface ProjectWorkflow extends Schema.Schema.Type<typeof ProjectWorkflow> {}

export const defaultProjectWorkflow = (): ProjectWorkflow => ({
  columns: [],
  assignments: [],
  sessionDetails: [],
});

export const ProjectWorkflowMutation = Schema.TaggedUnion({
  AddColumn: { column: ProjectWorkflowColumn },
  UpdateColumn: {
    columnId: ProjectWorkflowColumn.fields.id,
    name: Schema.optionalKey(ProjectWorkflowColumn.fields.name),
    color: Schema.optionalKey(ProjectWorkflowColor),
  },
  MoveColumn: {
    columnId: ProjectWorkflowColumn.fields.id,
    index: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(19)),
  },
  DeleteColumn: { columnId: ProjectWorkflowColumn.fields.id },
  SetSessionStatus: {
    sessionId: ProjectWorkflowAssignment.fields.sessionId,
    statusId: Schema.optionalKey(ProjectWorkflowColumn.fields.id),
  },
});
export type ProjectWorkflowMutation = typeof ProjectWorkflowMutation.Type;

export const defaultProjectSettings = (): ProjectSettings => ({
  worktreeCreateCommand: DEFAULT_WORKTREE_CREATE_COMMAND,
  worktreeSetupCommands: "",
});

export const ProjectRecord = Schema.Struct({
  path: nonEmptyBoundedString(4_096),
  name: nonEmptyBoundedString(512),
  addedAt: IsoTimestamp,
  lastOpenedAt: IsoTimestamp,
  settings: Schema.optionalKey(ProjectSettings),
  workflow: Schema.optionalKey(ProjectWorkflow),
});

const SessionIds = boundedArray(boundedString(256), 10_000).check(Schema.isUnique());

const RendererApplicationFields = {
  projects: boundedArray(ProjectRecord, 200),
  unreadSessionIds: SessionIds,
  trustedProjectPaths: boundedArray(boundedString(4_096), 200).check(Schema.isUnique()),
  fastModeSessionIds: SessionIds,
  utilityModel: Schema.optionalKey(UtilityModel),
  vscodeServerPath: Schema.optionalKey(boundedString(4_096)),
};

/** Broad renderer projection. Model Presets hydrate through their focused RPC group. */
export const RendererApplicationState = Schema.Struct(RendererApplicationFields);

export const RendererApplicationProjection = Schema.Struct({
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  state: RendererApplicationState,
});

/** Current main-owned Application value. Storage envelope versioning is separate. */
export const ApplicationState = Schema.Struct({
  ...RendererApplicationFields,
  modelPresets: boundedArray(ModelPreset, 100),
  defaultModelPresetId: Schema.optionalKey(Schema.String.check(Schema.isUUID(4))),
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

export interface ApplicationState extends Schema.Schema.Type<typeof ApplicationState> {}
export interface RendererApplicationState extends Schema.Schema.Type<
  typeof RendererApplicationState
> {}
export interface RendererApplicationProjection extends Schema.Schema.Type<
  typeof RendererApplicationProjection
> {}
export interface ProjectRecord extends Schema.Schema.Type<typeof ProjectRecord> {}
export interface UtilityModel extends Schema.Schema.Type<typeof UtilityModel> {}
export interface ModelPreset extends Schema.Schema.Type<typeof ModelPreset> {}

export const defaultApplicationState = (): ApplicationState => ({
  projects: [],
  unreadSessionIds: [],
  trustedProjectPaths: [],
  fastModeSessionIds: [],
  modelPresets: [],
});
