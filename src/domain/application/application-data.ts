import { Schema } from "effect";
import { ThinkingLevel } from "../../services/pi/model-data";
import { WORKFLOW_STATUS_COLORS } from "../../utils/workflow-status-palette";

export { WORKFLOW_STATUS_COLORS } from "../../utils/workflow-status-palette";

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

export const WorkflowStatusColor = Schema.Literals(WORKFLOW_STATUS_COLORS);
export type WorkflowStatusColor = typeof WorkflowStatusColor.Type;

export const PROJECT_WORKFLOW_SESSION_DESCRIPTION_MAX_LENGTH = 560;

export const WorkflowStatus = Schema.Struct({
  id: Schema.String.check(Schema.isUUID(4)),
  name: Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(40)),
  color: WorkflowStatusColor,
});
export interface WorkflowStatus extends Schema.Schema.Type<typeof WorkflowStatus> {}

const PROJECT_WORKFLOW_RESERVED_COLUMN_NAMES = new Set(["draft", "active", "resolved"]);
const PROJECT_WORKFLOW_COLUMN_NAME_MAX_LENGTH = 40;

export type WorkflowStatusNameValidation =
  | { readonly ok: true; readonly name: string }
  | { readonly ok: false; readonly message: string };

/** Pure workflow-status policy shared with renderer-side fast validation. */
export const validateWorkflowStatusName = (
  workflow: Pick<ProjectWorkflow, "columns">,
  name: string,
  currentColumnId?: string,
): WorkflowStatusNameValidation => {
  const normalized = name.trim();
  if (!normalized) return { ok: false, message: "Status names cannot be empty" };
  if (normalized.length > PROJECT_WORKFLOW_COLUMN_NAME_MAX_LENGTH)
    return {
      ok: false,
      message: `Status names cannot exceed ${PROJECT_WORKFLOW_COLUMN_NAME_MAX_LENGTH} characters`,
    };
  const key = normalized.toLowerCase();
  if (
    PROJECT_WORKFLOW_RESERVED_COLUMN_NAMES.has(key) ||
    workflow.columns.some(
      (column) => column.id !== currentColumnId && column.name.toLowerCase() === key,
    )
  )
    return {
      ok: false,
      message: "Status names must be unique and cannot use a system status name",
    };
  return { ok: true, name: normalized };
};
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
  columns: boundedArray(WorkflowStatus, 20),
  assignments: boundedArray(ProjectWorkflowAssignment, 10_000),
  sessionDetails: boundedArray(ProjectWorkflowSessionDetails, 10_000),
}).check(
  Schema.makeFilter(
    (workflow) => {
      const ids = workflow.columns.map((column) => column.id);
      const names = workflow.columns.map((column) => column.name.toLowerCase());
      return (
        new Set(ids).size === ids.length &&
        new Set(names).size === names.length &&
        names.every((name) => !PROJECT_WORKFLOW_RESERVED_COLUMN_NAMES.has(name)) &&
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

export const defaultGlobalWorkflowStatuses = (): ReadonlyArray<WorkflowStatus> => [
  { id: "00000000-0000-4000-8000-000000000001", name: "Feature", color: "blue" },
  { id: "00000000-0000-4000-8000-000000000002", name: "Bug", color: "rose" },
  { id: "00000000-0000-4000-8000-000000000003", name: "Research", color: "violet" },
  { id: "00000000-0000-4000-8000-000000000004", name: "Chore", color: "amber" },
];

export const defaultProjectWorkflow = (): ProjectWorkflow => ({
  columns: [],
  assignments: [],
  sessionDetails: [],
});

const WorkflowStatusMutationInput = Schema.Struct({
  id: WorkflowStatus.fields.id,
  name: boundedString(256),
  color: WorkflowStatusColor,
});

export const WorkflowStatusMutation = Schema.TaggedUnion({
  AddColumn: { column: WorkflowStatusMutationInput },
  UpdateColumn: {
    columnId: WorkflowStatus.fields.id,
    name: Schema.optionalKey(boundedString(256)),
    color: Schema.optionalKey(WorkflowStatusColor),
  },
  MoveColumn: {
    columnId: WorkflowStatus.fields.id,
    index: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(19)),
  },
  DeleteColumn: { columnId: WorkflowStatus.fields.id },
});
export type WorkflowStatusMutation = typeof WorkflowStatusMutation.Type;

export const ProjectWorkflowSessionDestination = Schema.TaggedUnion({
  Active: {},
  Custom: { statusId: WorkflowStatus.fields.id },
  Resolved: {},
});
export type ProjectWorkflowSessionDestination = typeof ProjectWorkflowSessionDestination.Type;

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
  globalWorkflowStatuses: boundedArray(WorkflowStatus, 20),
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
      const globalStatusIds = state.globalWorkflowStatuses.map((status) => status.id);
      const globalStatusNames = state.globalWorkflowStatuses.map((status) =>
        status.name.toLocaleLowerCase(),
      );
      return (
        new Set(projectPaths).size === projectPaths.length &&
        new Set(presetIds).size === presetIds.length &&
        new Set(globalStatusIds).size === globalStatusIds.length &&
        new Set(globalStatusNames).size === globalStatusNames.length &&
        state.projects.every((project) => {
          const workflow = project.workflow ?? defaultProjectWorkflow();
          return (
            workflow.columns.every(
              (status) =>
                !globalStatusIds.includes(status.id) &&
                !globalStatusNames.includes(status.name.toLocaleLowerCase()),
            ) &&
            workflow.assignments.every((assignment) =>
              [...globalStatusIds, ...workflow.columns.map((status) => status.id)].includes(
                assignment.statusId,
              ),
            )
          );
        }) &&
        (state.defaultModelPresetId === undefined || presetIds.includes(state.defaultModelPresetId))
      );
    },
    {
      expected:
        "unique Project, Model Preset, and workflow status identities with valid references",
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
  globalWorkflowStatuses: [...defaultGlobalWorkflowStatuses()],
  unreadSessionIds: [],
  trustedProjectPaths: [],
  fastModeSessionIds: [],
  modelPresets: [],
});
