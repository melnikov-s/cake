import { DateTime, Effect, Schema } from "effect";
import {
  ApplicationState as ApplicationStateSchema,
  type ApplicationState,
  defaultProjectWorkflow,
  type ProjectSettings,
  type WorkflowStatus,
  type ProjectWorkflow,
  type WorkflowStatusMutation,
  type ProjectWorkflowSessionDetails,
  type UtilityModel,
  validateWorkflowStatusName,
} from "./application-data";
import { ApplicationState as ApplicationStateOwner } from "../../services/storage/ApplicationState";

class ApplicationPolicyError extends Schema.TaggedError<ApplicationPolicyError>()(
  "ApplicationPolicyError",
  { message: Schema.String },
) {}

const unique = (values: ReadonlyArray<string>): ReadonlyArray<string> => [...new Set(values)];

const validate = Effect.fn("Application.validate")((state: ApplicationState) =>
  Schema.decodeUnknownEffect(ApplicationStateSchema)(state).pipe(
    Effect.mapError((cause) => new ApplicationPolicyError({ message: cause.message })),
  ),
);

const update = Effect.fn("Application.update")(function* (
  transition: (current: ApplicationState) => ApplicationState,
) {
  const owner = yield* ApplicationStateOwner;
  return yield* owner.transact((current) => validate(transition(current)));
});

export const initialize = Effect.fn("Application.initialize")(function* () {
  const owner = yield* ApplicationStateOwner;
  return yield* owner.initialize();
});

export const getState = Effect.fn("Application.getState")(function* () {
  const owner = yield* ApplicationStateOwner;
  return yield* owner.current();
});

export const observeState = Effect.fn("Application.observeState")(function* () {
  const owner = yield* ApplicationStateOwner;
  return owner.changes();
});

export const upsertProject = Effect.fn("Application.upsertProject")(function* (
  path: string,
  defaultName: string,
) {
  const now = DateTime.formatIso(yield* DateTime.now);
  const owner = yield* ApplicationStateOwner;
  return yield* owner.transact((current) => {
    const existing = current.projects.find((project) => project.path === path);
    if (existing)
      return validate({
        ...current,
        projects: current.projects.map((project) =>
          project.path === path ? { ...project, lastOpenedAt: now } : project,
        ),
      });
    if (current.projects.length >= 200)
      return Effect.fail(new ApplicationPolicyError({ message: "Project registry is full" }));
    return validate({
      ...current,
      projects: [{ path, name: defaultName, addedAt: now, lastOpenedAt: now }, ...current.projects],
    });
  });
});

export const touchProject = Effect.fn("Application.touchProject")(function* (
  path: string,
  at?: string,
) {
  const touchedAt = at ?? DateTime.formatIso(yield* DateTime.now);
  return yield* update((current) => ({
    ...current,
    projects: current.projects.map((project) =>
      project.path === path ? { ...project, lastOpenedAt: touchedAt } : project,
    ),
  }));
});

export const renameProject = Effect.fn("Application.renameProject")(function* (
  path: string,
  name: string,
) {
  const nextName = name.trim().slice(0, 512);
  return yield* update((current) => ({
    ...current,
    projects: current.projects.map((project) =>
      project.path === path && nextName ? { ...project, name: nextName } : project,
    ),
  }));
});

export const setProjectSettings = Effect.fn("Application.setProjectSettings")(function* (
  path: string,
  settings: ProjectSettings,
) {
  return yield* update((current) => ({
    ...current,
    projects: current.projects.map((project) =>
      project.path === path ? { ...project, settings } : project,
    ),
  }));
});

const mutateWorkflowValue = Effect.fn("Application.mutateWorkflowValue")(function* (
  workflow: ProjectWorkflow,
  otherStatuses: ReadonlyArray<WorkflowStatus>,
  mutation:
    | WorkflowStatusMutation
    | {
        readonly _tag: "SetSessionStatus";
        readonly sessionId: string;
        readonly statusId?: string;
      }
    | { readonly _tag: "SetSessionDetails"; readonly details: ProjectWorkflowSessionDetails },
) {
  if (mutation._tag === "AddColumn") {
    if (workflow.columns.length >= 20)
      return yield* new ApplicationPolicyError({
        message: "A status list can contain at most 20 statuses",
      });
    const validation = validateWorkflowStatusName(
      { columns: [...otherStatuses, ...workflow.columns] },
      mutation.column.name,
    );
    if (!validation.ok) return yield* new ApplicationPolicyError({ message: validation.message });
    return {
      ...workflow,
      columns: [...workflow.columns, { ...mutation.column, name: validation.name }],
    };
  }
  if (mutation._tag === "SetSessionDetails")
    return {
      ...workflow,
      sessionDetails: [
        ...workflow.sessionDetails.filter(
          (details) => details.sessionId !== mutation.details.sessionId,
        ),
        mutation.details,
      ],
    };
  if (mutation._tag === "SetSessionStatus") {
    const assignments = workflow.assignments.filter(
      (assignment) => assignment.sessionId !== mutation.sessionId,
    );
    if (mutation.statusId !== undefined) {
      if (
        ![...otherStatuses, ...workflow.columns].some((column) => column.id === mutation.statusId)
      )
        return yield* new ApplicationPolicyError({
          message: "That custom status no longer exists",
        });
      assignments.push({ sessionId: mutation.sessionId, statusId: mutation.statusId });
    }
    return { ...workflow, assignments };
  }
  const columnIndex = workflow.columns.findIndex((column) => column.id === mutation.columnId);
  if (columnIndex < 0)
    return yield* new ApplicationPolicyError({ message: "That custom status no longer exists" });
  if (mutation._tag === "UpdateColumn") {
    const name =
      mutation.name === undefined
        ? undefined
        : validateWorkflowStatusName(
            { columns: [...otherStatuses, ...workflow.columns] },
            mutation.name,
            mutation.columnId,
          );
    if (name && !name.ok) return yield* new ApplicationPolicyError({ message: name.message });
    return {
      ...workflow,
      columns: workflow.columns.map((column, index) =>
        index === columnIndex
          ? {
              ...column,
              ...(name === undefined ? undefined : { name: name.name }),
              ...(mutation.color === undefined ? undefined : { color: mutation.color }),
            }
          : column,
      ),
    };
  }
  if (mutation._tag === "MoveColumn") {
    const columns = [...workflow.columns];
    const column = columns[columnIndex];
    if (!column)
      return yield* new ApplicationPolicyError({ message: "That custom status no longer exists" });
    columns.splice(columnIndex, 1);
    columns.splice(Math.min(mutation.index, columns.length), 0, column);
    return { ...workflow, columns };
  }
  if (mutation._tag === "DeleteColumn")
    return {
      ...workflow,
      columns: workflow.columns.filter((column) => column.id !== mutation.columnId),
      assignments: workflow.assignments.filter(
        (assignment) => assignment.statusId !== mutation.columnId,
      ),
    };
  return workflow;
});

const mutateProjectWorkflowValue = Effect.fn("Application.mutateProjectWorkflowValue")(function* (
  path: string,
  mutation:
    | WorkflowStatusMutation
    | {
        readonly _tag: "SetSessionStatus";
        readonly sessionId: string;
        readonly statusId?: string;
      }
    | { readonly _tag: "SetSessionDetails"; readonly details: ProjectWorkflowSessionDetails },
) {
  const owner = yield* ApplicationStateOwner;
  const state = yield* owner.transact((current) => {
    const project = current.projects.find((candidate) => candidate.path === path);
    if (!project)
      return Effect.fail(new ApplicationPolicyError({ message: "That Project is not registered" }));
    return Effect.gen(function* () {
      const workflow = yield* mutateWorkflowValue(
        project.workflow ?? defaultProjectWorkflow(),
        current.globalWorkflowStatuses,
        mutation,
      );
      return yield* validate({
        ...current,
        projects: current.projects.map((candidate) =>
          candidate.path === path ? { ...candidate, workflow } : candidate,
        ),
      });
    });
  });
  return (
    state.projects.find((project) => project.path === path)?.workflow ?? defaultProjectWorkflow()
  );
});

export const mutateProjectWorkflow = Effect.fn("Application.mutateProjectWorkflow")(
  (path: string, mutation: WorkflowStatusMutation) => mutateProjectWorkflowValue(path, mutation),
);

export const mutateGlobalWorkflowStatuses = Effect.fn("Application.mutateGlobalWorkflowStatuses")(
  function* (mutation: WorkflowStatusMutation) {
    const owner = yield* ApplicationStateOwner;
    return yield* owner.transact((current) => {
      const workflow: ProjectWorkflow = {
        columns: current.globalWorkflowStatuses,
        assignments: [],
        sessionDetails: [],
      };
      return Effect.gen(function* () {
        const allProjectStatuses = current.projects.flatMap(
          (project) => project.workflow?.columns ?? [],
        );
        const statuses = yield* mutateWorkflowValue(workflow, allProjectStatuses, mutation).pipe(
          Effect.map((updated) => updated.columns),
        );
        return yield* validate({
          ...current,
          globalWorkflowStatuses: statuses,
          projects:
            mutation._tag === "DeleteColumn"
              ? current.projects.map((project) =>
                  project.workflow
                    ? {
                        ...project,
                        workflow: {
                          ...project.workflow,
                          assignments: project.workflow.assignments.filter(
                            (assignment) => assignment.statusId !== mutation.columnId,
                          ),
                        },
                      }
                    : project,
                )
              : current.projects,
        });
      });
    });
  },
);

export const setProjectWorkflowSessionStatus = Effect.fn(
  "Application.setProjectWorkflowSessionStatus",
)((path: string, sessionId: string, statusId?: string) =>
  mutateProjectWorkflowValue(path, {
    _tag: "SetSessionStatus",
    sessionId,
    ...(statusId === undefined ? undefined : { statusId }),
  }),
);

export const setProjectWorkflowSessionDetails = Effect.fn(
  "Application.setProjectWorkflowSessionDetails",
)((path: string, details: ProjectWorkflowSessionDetails) =>
  mutateProjectWorkflowValue(path, { _tag: "SetSessionDetails", details }),
);

export const removeProject = Effect.fn("Application.removeProject")(function* (path: string) {
  return yield* update((current) => ({
    ...current,
    projects: current.projects.filter((project) => project.path !== path),
    trustedProjectPaths: current.trustedProjectPaths.filter((trusted) => trusted !== path),
  }));
});

export const trustProject = Effect.fn("Application.trustProject")(function* (path: string) {
  const owner = yield* ApplicationStateOwner;
  return yield* owner.transact((current) => {
    if (current.trustedProjectPaths.includes(path)) return Effect.succeed(current);
    return validate({
      ...current,
      trustedProjectPaths: [...current.trustedProjectPaths, path],
    });
  });
});

export const revokeProjectTrust = Effect.fn("Application.revokeProjectTrust")(function* (
  path: string,
) {
  return yield* update((current) => ({
    ...current,
    trustedProjectPaths: current.trustedProjectPaths.filter((trusted) => trusted !== path),
  }));
});

export const setUtilityModel = Effect.fn("Application.setUtilityModel")(function* (
  model: UtilityModel | undefined,
) {
  return yield* update((current) => {
    const withoutUtilityModel = { ...current };
    Reflect.deleteProperty(withoutUtilityModel, "utilityModel");
    return model === undefined
      ? withoutUtilityModel
      : { ...withoutUtilityModel, utilityModel: model };
  });
});

export const setVscodeServerPath = Effect.fn("Application.setVscodeServerPath")(function* (
  path: string | undefined,
) {
  return yield* update((current) => {
    const withoutVscodeServerPath = { ...current };
    Reflect.deleteProperty(withoutVscodeServerPath, "vscodeServerPath");
    const normalized = path?.trim();
    return normalized
      ? { ...withoutVscodeServerPath, vscodeServerPath: normalized }
      : withoutVscodeServerPath;
  });
});

export const setSessionFastMode = Effect.fn("Application.setSessionFastMode")(function* (
  sessionId: string,
  enabled: boolean,
) {
  return yield* update((current) => ({
    ...current,
    fastModeSessionIds: enabled
      ? unique([...current.fastModeSessionIds, sessionId])
      : current.fastModeSessionIds.filter((id) => id !== sessionId),
  }));
});

export const setSessionUnread = Effect.fn("Application.setSessionUnread")(function* (
  sessionId: string,
  unread: boolean,
) {
  return yield* update((current) => ({
    ...current,
    unreadSessionIds: unread
      ? unique([...current.unreadSessionIds, sessionId])
      : current.unreadSessionIds.filter((id) => id !== sessionId),
  }));
});

export const forgetProjectSessions = Effect.fn("Application.forgetProjectSessions")(function* (
  sessionIds: ReadonlyArray<string>,
) {
  const forgotten = new Set(sessionIds);
  return yield* update((current) => ({
    ...current,
    unreadSessionIds: current.unreadSessionIds.filter((id) => !forgotten.has(id)),
    fastModeSessionIds: current.fastModeSessionIds.filter((id) => !forgotten.has(id)),
    projects: current.projects.map((project) =>
      project.workflow
        ? {
            ...project,
            workflow: {
              ...project.workflow,
              assignments: project.workflow.assignments.filter(
                (assignment) => !forgotten.has(assignment.sessionId),
              ),
              sessionDetails: project.workflow.sessionDetails.filter(
                (details) => !forgotten.has(details.sessionId),
              ),
            },
          }
        : project,
    ),
  }));
});
