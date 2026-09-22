import { DateTime, Effect, Schema } from "effect";
import type { CakePrompts } from "./cake-prompts";
import {
  ApplicationState as ApplicationStateSchema,
  type ApplicationState,
  defaultProjectWorkflow,
  type ProjectSettings,
  type SessionLabel,
  type ProjectWorkflow,
  type SessionLabelMutation,
  type ProjectWorkflowSessionDetails,
  type SessionPlugin,
  type UtilityModel,
  validateSessionLabelName,
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
  otherLabels: ReadonlyArray<SessionLabel>,
  mutation:
    | SessionLabelMutation
    | {
        readonly _tag: "SetSessionLabels";
        readonly sessionId: string;
        readonly labelIds: ReadonlyArray<string>;
      }
    | { readonly _tag: "SetSessionDetails"; readonly details: ProjectWorkflowSessionDetails },
) {
  if (mutation._tag === "AddLabel") {
    if (workflow.labels.length >= 100)
      return yield* new ApplicationPolicyError({
        message: "A label list can contain at most 100 labels",
      });
    const validation = validateSessionLabelName(mutation.label.name);
    if (!validation.ok) return yield* new ApplicationPolicyError({ message: validation.message });
    return {
      ...workflow,
      labels: [...workflow.labels, { ...mutation.label, name: validation.name }],
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
  if (mutation._tag === "SetSessionLabels") {
    const labelIds = unique(mutation.labelIds);
    const availableIds = new Set([...otherLabels, ...workflow.labels].map((label) => label.id));
    if (labelIds.some((labelId) => !availableIds.has(labelId)))
      return yield* new ApplicationPolicyError({ message: "A selected label no longer exists" });
    const assignments = workflow.assignments.filter(
      (assignment) => assignment.sessionId !== mutation.sessionId,
    );
    if (labelIds.length > 0) assignments.push({ sessionId: mutation.sessionId, labelIds });
    return { ...workflow, assignments };
  }
  const labelIndex = workflow.labels.findIndex((label) => label.id === mutation.labelId);
  if (labelIndex < 0)
    return yield* new ApplicationPolicyError({ message: "That label no longer exists" });
  if (mutation._tag === "UpdateLabel") {
    const name = mutation.name === undefined ? undefined : validateSessionLabelName(mutation.name);
    if (name && !name.ok) return yield* new ApplicationPolicyError({ message: name.message });
    return {
      ...workflow,
      labels: workflow.labels.map((label, index) =>
        index === labelIndex
          ? {
              ...label,
              ...(name === undefined ? undefined : { name: name.name }),
              ...(mutation.color === undefined ? undefined : { color: mutation.color }),
            }
          : label,
      ),
    };
  }
  if (mutation._tag === "MoveLabel") {
    const labels = [...workflow.labels];
    const label = labels[labelIndex];
    if (!label)
      return yield* new ApplicationPolicyError({ message: "That label no longer exists" });
    labels.splice(labelIndex, 1);
    labels.splice(Math.min(mutation.index, labels.length), 0, label);
    return { ...workflow, labels };
  }
  if (mutation._tag === "DeleteLabel")
    return {
      ...workflow,
      labels: workflow.labels.filter((label) => label.id !== mutation.labelId),
      assignments: workflow.assignments.flatMap((assignment) => {
        const labelIds = assignment.labelIds.filter((labelId) => labelId !== mutation.labelId);
        return labelIds.length > 0 ? [{ ...assignment, labelIds }] : [];
      }),
    };
  return workflow;
});

const mutateProjectWorkflowValue = Effect.fn("Application.mutateProjectWorkflowValue")(function* (
  path: string,
  mutation:
    | SessionLabelMutation
    | {
        readonly _tag: "SetSessionLabels";
        readonly sessionId: string;
        readonly labelIds: ReadonlyArray<string>;
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
        current.globalSessionLabels,
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
  (path: string, mutation: SessionLabelMutation) => mutateProjectWorkflowValue(path, mutation),
);

export const mutateGlobalSessionLabels = Effect.fn("Application.mutateGlobalSessionLabels")(
  function* (mutation: SessionLabelMutation) {
    const owner = yield* ApplicationStateOwner;
    return yield* owner.transact((current) => {
      const workflow: ProjectWorkflow = {
        labels: current.globalSessionLabels,
        assignments: [],
        sessionDetails: [],
      };
      return Effect.gen(function* () {
        const allProjectLabels = current.projects.flatMap(
          (project) => project.workflow?.labels ?? [],
        );
        const labels = yield* mutateWorkflowValue(workflow, allProjectLabels, mutation).pipe(
          Effect.map((updated) => updated.labels),
        );
        return yield* validate({
          ...current,
          globalSessionLabels: labels,
          projects:
            mutation._tag === "DeleteLabel"
              ? current.projects.map((project) =>
                  project.workflow
                    ? {
                        ...project,
                        workflow: {
                          ...project.workflow,
                          assignments: project.workflow.assignments.flatMap((assignment) => {
                            const labelIds = assignment.labelIds.filter(
                              (labelId) => labelId !== mutation.labelId,
                            );
                            return labelIds.length > 0 ? [{ ...assignment, labelIds }] : [];
                          }),
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

export const setProjectSessionLabels = Effect.fn("Application.setProjectSessionLabels")(
  (path: string, sessionId: string, labelIds: ReadonlyArray<string>) =>
    mutateProjectWorkflowValue(path, { _tag: "SetSessionLabels", sessionId, labelIds }),
);

export const setProjectSessionLabelsIfUnlabelled = Effect.fn(
  "Application.setProjectSessionLabelsIfUnlabelled",
)(function* (path: string, sessionId: string, labelIds: ReadonlyArray<string>) {
  const owner = yield* ApplicationStateOwner;
  const state = yield* owner.transact((current) => {
    const project = current.projects.find((candidate) => candidate.path === path);
    if (!project)
      return Effect.fail(new ApplicationPolicyError({ message: "That Project is not registered" }));
    const workflow = project.workflow ?? defaultProjectWorkflow();
    const currentAssignment = workflow.assignments.find(
      (assignment) => assignment.sessionId === sessionId,
    );
    if (currentAssignment?.labelIds.length) return Effect.succeed(current);
    return Effect.gen(function* () {
      const updated = yield* mutateWorkflowValue(workflow, current.globalSessionLabels, {
        _tag: "SetSessionLabels",
        sessionId,
        labelIds,
      });
      return yield* validate({
        ...current,
        projects: current.projects.map((candidate) =>
          candidate.path === path ? { ...candidate, workflow: updated } : candidate,
        ),
      });
    });
  });
  return (
    state.projects.find((project) => project.path === path)?.workflow ?? defaultProjectWorkflow()
  );
});

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

export const setCakePrompts = Effect.fn("Application.setCakePrompts")(function* (
  cakePrompts: CakePrompts,
) {
  return yield* update((current) => ({ ...current, cakePrompts }));
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

export const upsertSessionPlugin = Effect.fn("Application.upsertSessionPlugin")(function* (
  plugin: SessionPlugin,
) {
  return yield* update((current) => {
    const existing = current.sessionPlugins.findIndex(
      (candidate) => candidate.sessionId === plugin.sessionId && candidate.id === plugin.id,
    );
    return {
      ...current,
      sessionPlugins:
        existing < 0
          ? [...current.sessionPlugins, plugin]
          : current.sessionPlugins.map((candidate, index) =>
              index === existing ? { ...plugin, createdAt: candidate.createdAt } : candidate,
            ),
    };
  });
});

export const setSessionPluginState = Effect.fn("Application.setSessionPluginState")(function* (
  sessionId: string,
  pluginId: string,
  state: typeof Schema.Json.Type,
) {
  const updatedAt = DateTime.formatIso(yield* DateTime.now);
  return yield* update((current) => ({
    ...current,
    sessionPlugins: current.sessionPlugins.map((plugin) =>
      plugin.sessionId === sessionId && plugin.id === pluginId
        ? { ...plugin, state, updatedAt }
        : plugin,
    ),
  }));
});

export const deleteSessionPlugin = Effect.fn("Application.deleteSessionPlugin")(function* (
  sessionId: string,
  pluginId: string,
) {
  return yield* update((current) => ({
    ...current,
    sessionPlugins: current.sessionPlugins.filter(
      (plugin) => plugin.sessionId !== sessionId || plugin.id !== pluginId,
    ),
  }));
});

export const setSessionPluginSharedState = Effect.fn("Application.setSessionPluginSharedState")(
  function* (sessionId: string, key: string, value: typeof Schema.Json.Type) {
    return yield* update((current) => {
      const existing = current.sessionPluginSharedState.findIndex(
        (entry) => entry.sessionId === sessionId && entry.key === key,
      );
      const entry = { sessionId, key, value };
      return {
        ...current,
        sessionPluginSharedState:
          existing < 0
            ? [...current.sessionPluginSharedState, entry]
            : current.sessionPluginSharedState.map((candidate, index) =>
                index === existing ? entry : candidate,
              ),
      };
    });
  },
);

export const forgetProjectSessions = Effect.fn("Application.forgetProjectSessions")(function* (
  sessionIds: ReadonlyArray<string>,
) {
  const forgotten = new Set(sessionIds);
  return yield* update((current) => ({
    ...current,
    unreadSessionIds: current.unreadSessionIds.filter((id) => !forgotten.has(id)),
    fastModeSessionIds: current.fastModeSessionIds.filter((id) => !forgotten.has(id)),
    sessionPlugins: current.sessionPlugins.filter((plugin) => !forgotten.has(plugin.sessionId)),
    sessionPluginSharedState: current.sessionPluginSharedState.filter(
      (entry) => !forgotten.has(entry.sessionId),
    ),
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
