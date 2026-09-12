import { Effect, Schema } from "effect";
import { ThinkingLevel } from "../../services/pi/model-data";
import { SESSION_LABEL_COLORS } from "../../utils/session-label-palette";

export { SESSION_LABEL_COLORS } from "../../utils/session-label-palette";

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
  worktreeSetupInstructions: boundedString(16_384).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed("")),
  ),
});

export interface ProjectSettings extends Schema.Schema.Type<typeof ProjectSettings> {}

export const SessionLabelColor = Schema.Literals(SESSION_LABEL_COLORS);
export type SessionLabelColor = typeof SessionLabelColor.Type;

export const PROJECT_WORKFLOW_SESSION_DESCRIPTION_MAX_LENGTH = 560;

export const SessionLabel = Schema.Struct({
  id: Schema.String.check(Schema.isUUID(4)),
  name: Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(40)),
  color: SessionLabelColor,
});
export interface SessionLabel extends Schema.Schema.Type<typeof SessionLabel> {}

const SESSION_LABEL_NAME_MAX_LENGTH = 40;

export type SessionLabelNameValidation =
  | { readonly ok: true; readonly name: string }
  | { readonly ok: false; readonly message: string };

/** Pure label-name policy shared with renderer-side fast validation. */
export const validateSessionLabelName = (name: string): SessionLabelNameValidation => {
  const normalized = name.trim();
  if (!normalized) return { ok: false, message: "Label names cannot be empty" };
  if (normalized.length > SESSION_LABEL_NAME_MAX_LENGTH)
    return {
      ok: false,
      message: `Label names cannot exceed ${SESSION_LABEL_NAME_MAX_LENGTH} characters`,
    };
  return { ok: true, name: normalized };
};
const ProjectWorkflowAssignment = Schema.Struct({
  sessionId: nonEmptyBoundedString(256),
  labelIds: boundedArray(Schema.String.check(Schema.isUUID(4)), 100).check(Schema.isUnique()),
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
  labels: boundedArray(SessionLabel, 100),
  assignments: boundedArray(ProjectWorkflowAssignment, 10_000),
  sessionDetails: boundedArray(ProjectWorkflowSessionDetails, 10_000),
}).check(
  Schema.makeFilter(
    (workflow) => {
      const ids = workflow.labels.map((label) => label.id);
      return (
        new Set(ids).size === ids.length &&
        new Set(workflow.assignments.map((assignment) => assignment.sessionId)).size ===
          workflow.assignments.length &&
        new Set(workflow.sessionDetails.map((details) => details.sessionId)).size ===
          workflow.sessionDetails.length
      );
    },
    { expected: "a valid project workflow with unique label identities and session records" },
  ),
);
export interface ProjectWorkflow extends Schema.Schema.Type<typeof ProjectWorkflow> {}

export const defaultGlobalSessionLabels = (): ReadonlyArray<SessionLabel> => [
  { id: "00000000-0000-4000-8000-000000000001", name: "Feature", color: "blue" },
  { id: "00000000-0000-4000-8000-000000000002", name: "Bug", color: "rose" },
  { id: "00000000-0000-4000-8000-000000000003", name: "Maintenance", color: "amber" },
  { id: "00000000-0000-4000-8000-000000000004", name: "Architecture", color: "violet" },
  { id: "00000000-0000-4000-8000-000000000005", name: "UI", color: "pink" },
  { id: "00000000-0000-4000-8000-000000000006", name: "Data", color: "cyan" },
  { id: "00000000-0000-4000-8000-000000000007", name: "Infrastructure", color: "orange" },
  { id: "00000000-0000-4000-8000-000000000008", name: "Documentation", color: "mint" },
  { id: "00000000-0000-4000-8000-000000000009", name: "Testing", color: "green" },
  { id: "00000000-0000-4000-8000-000000000010", name: "Tooling", color: "indigo" },
];

export const defaultProjectWorkflow = (): ProjectWorkflow => ({
  labels: [],
  assignments: [],
  sessionDetails: [],
});

const SessionLabelMutationInput = Schema.Struct({
  id: SessionLabel.fields.id,
  name: boundedString(256),
  color: SessionLabelColor,
});

export const SessionLabelMutation = Schema.TaggedUnion({
  AddLabel: { label: SessionLabelMutationInput },
  UpdateLabel: {
    labelId: SessionLabel.fields.id,
    name: Schema.optionalKey(boundedString(256)),
    color: Schema.optionalKey(SessionLabelColor),
  },
  MoveLabel: {
    labelId: SessionLabel.fields.id,
    index: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(99)),
  },
  DeleteLabel: { labelId: SessionLabel.fields.id },
});
export type SessionLabelMutation = typeof SessionLabelMutation.Type;

export const defaultProjectSettings = (): ProjectSettings => ({
  worktreeCreateCommand: DEFAULT_WORKTREE_CREATE_COMMAND,
  worktreeSetupCommands: "",
  worktreeSetupInstructions: "",
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
  globalSessionLabels: boundedArray(SessionLabel, 100),
  unreadSessionIds: SessionIds,
  trustedProjectPaths: Schema.Array(boundedString(4_096)).check(Schema.isUnique()),
  fastModeSessionIds: SessionIds,
  utilityModel: Schema.optionalKey(UtilityModel),
  vscodeServerPath: Schema.optionalKey(boundedString(4_096)),
  modelPresets: boundedArray(ModelPreset, 100),
  defaultModelPresetId: Schema.optionalKey(Schema.String.check(Schema.isUUID(4))),
};

const CurrentApplicationState = Schema.Struct(RendererApplicationFields).check(
  Schema.makeFilter(
    (state) => {
      const projectPaths = state.projects.map((project) => project.path);
      const presetIds = state.modelPresets.map((preset) => preset.id);
      const globalLabelIds = state.globalSessionLabels.map((label) => label.id);
      return (
        new Set(projectPaths).size === projectPaths.length &&
        new Set(presetIds).size === presetIds.length &&
        new Set(globalLabelIds).size === globalLabelIds.length &&
        state.projects.every((project) => {
          const workflow = project.workflow ?? defaultProjectWorkflow();
          const availableLabelIds = [
            ...globalLabelIds,
            ...workflow.labels.map((label) => label.id),
          ];
          return (
            workflow.labels.every((label) => !globalLabelIds.includes(label.id)) &&
            workflow.assignments.every((assignment) =>
              assignment.labelIds.every((labelId) => availableLabelIds.includes(labelId)),
            )
          );
        }) &&
        (state.defaultModelPresetId === undefined || presetIds.includes(state.defaultModelPresetId))
      );
    },
    {
      expected: "unique Project, Model Preset, and session-label identities with valid references",
    },
  ),
);

/** Broad renderer projection of current main-owned application state. */
export const RendererApplicationState = CurrentApplicationState;

export const RendererApplicationProjection = Schema.Struct({
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  state: RendererApplicationState,
});

/** Current main-owned Application value. Storage envelope versioning is separate. */
export const ApplicationState = CurrentApplicationState;

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
  globalSessionLabels: [...defaultGlobalSessionLabels()],
  unreadSessionIds: [],
  trustedProjectPaths: [],
  fastModeSessionIds: [],
  modelPresets: [],
});
