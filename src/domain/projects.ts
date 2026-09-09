import * as projectSessionLocations from "./projectSessionLocations";
import type { WebContents } from "electron";
import { Effect, Stream } from "effect";
import type { cakeRpcPayloadSchemas } from "../ipc/cake-rpc-contract";
import { Electron } from "../services/electron/Electron";
import { PiSessions } from "../services/pi/PiSessions";
import { PiAgentResources } from "../services/pi/PiAgentResources";
import { AgentAvailability } from "../services/pi/AgentAvailability";
import { ProjectSessionRuntimeHost } from "../services/pi/ProjectSessionRuntimeHost";
import { rewordSelectionWithProjectContext } from "../services/pi/runtime/rewording-agent";
import { inspectWorkspace } from "../services/pi/runtime/session-discovery";
import { ProjectAccess } from "../services/projects/ProjectAccess";
import { ProjectConfiguration } from "../services/projects/ProjectConfiguration";
import { RewordingRequests } from "../services/projects/RewordingRequests";
import { SessionCatalogChanges } from "../services/session-catalogs/SessionCatalogChanges";
import { ApplicationState } from "../services/storage/ApplicationState";
import { SessionArchiveStorage } from "../services/storage/SessionArchiveStorage";
import { ManagedWorktrees } from "../services/worktrees/ManagedWorktrees";
import { resolveRewordingWorkspace } from "../services/projects/rewording-workspace";
import type { ProjectCatalogUpdate } from "./catalog-data";
import type {
  ProjectRecord,
  ProjectWorkflowMutation,
  ProjectWorkflowSessionDetails,
  ProjectWorkflowSessionDestination,
} from "./application-data";
import { defaultProjectWorkflow } from "./application-data";
import { inspect as inspectProjectSession } from "./projectSessionMetadata";
import * as projectSessionLifecycle from "./projectSessionLifecycle";
import { ProjectError } from "./project-error";
import {
  observeState,
  removeProject,
  renameProject,
  mutateProjectWorkflow,
  setProjectWorkflowSessionDetails,
  setProjectSettings as setApplicationProjectSettings,
  setSessionUnread as setApplicationSessionUnread,
  setUtilityModel as setApplicationUtilityModel,
  trustProject,
  upsertProject,
} from "./application";
import {
  dictationRewordingGuidance,
  generateSessionDescription as generateUtilitySessionDescription,
  generateSessionTitle as generateUtilitySessionTitle,
  REWORD_CHARACTER_LIMIT,
  rewordSelection,
  utilityModelSelection,
} from "./utilityWork";

type Payload<Type extends keyof typeof cakeRpcPayloadSchemas> =
  (typeof cakeRpcPayloadSchemas)[Type]["Type"];

interface ProjectCatalogObservation {
  readonly revision: number;
  readonly projects: ReadonlyArray<ProjectRecord> | undefined;
}

const projectError = (operation: string, cause: unknown) =>
  new ProjectError({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
  });

const mapProjectError = <A, E, R>(operation: string, effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.mapError((cause) => projectError(operation, cause)));

const requireAllowed = Effect.fn("Projects.requireAllowed")(function* (workingDirectory: string) {
  const access = yield* ProjectAccess;
  if (!(yield* access.isAllowed(workingDirectory)))
    return yield* new ProjectError({
      operation: "authorizeWorkingDirectory",
      message: "Project path was not selected by the user",
    });
});

const requireConnection = Effect.fn("Projects.requireConnection")(function* (
  connectionId: number,
  operation: string,
): Effect.fn.Return<WebContents, ProjectError, Electron> {
  const electron = yield* Electron;
  return yield* Effect.try({
    try: () => electron.requireRendererConnection(connectionId),
    catch: (cause) => projectError(operation, cause),
  });
});

/** Restores authorization for previously user-registered Projects without inspecting sessions. */
export const initializeRegisteredProjectAccess = Effect.fn(
  "Projects.initializeRegisteredProjectAccess",
)(function* () {
  const application = yield* ApplicationState;
  const access = yield* ProjectAccess;
  const worktrees = yield* ManagedWorktrees;
  const projectPaths = new Set(application.snapshot().projects.map((project) => project.path));
  const records = yield* mapProjectError("initializeRegisteredProjectAccess", worktrees.records());
  const workingDirectories = [
    ...projectPaths,
    ...records
      .filter((record) => projectPaths.has(record.projectPath))
      .map((record) => record.worktreePath),
  ];
  yield* Effect.forEach(workingDirectories, (path) => access.allow(path), { discard: true });
});

const resolveRewordingWorkingDirectory = Effect.fn("Projects.resolveRewordingWorkingDirectory")(
  function* (requested: string | undefined, active: string | undefined) {
    const access = yield* ProjectAccess;
    const allowed = yield* mapProjectError(
      "rewordComposerSelection",
      access.allowedWorkingDirectories(),
    );
    return yield* Effect.tryPromise({
      try: () =>
        resolveRewordingWorkspace({
          requestedWorkspace: requested,
          activeWorkspace: active,
          allowedWorkspacePaths: new Set(allowed),
        }),
      catch: (cause) => projectError("rewordComposerSelection", cause),
    });
  },
);

export const rewordComposerSelection = Effect.fn("Projects.rewordComposerSelection")(function* (
  connectionId: number,
  request: Payload<"reword-composer-selection">,
) {
  const application = yield* ApplicationState;
  const electron = yield* Electron;
  const configuration = yield* ProjectConfiguration;
  const requests = yield* RewordingRequests;
  const sender = yield* requireConnection(connectionId, "rewordComposerSelection");
  const utilityModel = application.snapshot().utilityModel;
  if (!utilityModel)
    return yield* new ProjectError({
      operation: "rewordComposerSelection",
      message: "Configure a utility model in Settings before rewording text",
    });

  const controller = yield* requests.acquire(sender.id);
  const operation = Effect.gen(function* () {
    const workingDirectory = yield* resolveRewordingWorkingDirectory(
      request.workspacePath,
      electron.workspaceForConnection(sender.id),
    );
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(workingDirectory ? 60_000 : 30_000),
    ]);
    const text = workingDirectory
      ? yield* Effect.tryPromise({
          try: () =>
            rewordSelectionWithProjectContext({
              workspacePath: workingDirectory,
              agentDir: configuration.agentDirectory,
              utilityModel,
              selection: request.selection,
              guidance: request.prompt,
              systemGuidance: dictationRewordingGuidance,
              characterLimit: REWORD_CHARACTER_LIMIT,
              signal,
            }),
          catch: (cause) => projectError("rewordComposerSelection", cause),
        })
      : yield* mapProjectError(
          "rewordComposerSelection",
          rewordSelection({
            selection: utilityModelSelection(utilityModel),
            text: request.selection,
            guidance: request.prompt,
          }),
        );
    return { text };
  });
  return yield* operation.pipe(Effect.ensuring(requests.release(sender.id, controller)));
});

export const generateSessionTitle = Effect.fn("Projects.generateSessionTitle")(function* (
  _connectionId: number,
  request: Payload<"generate-session-title">,
) {
  const application = yield* ApplicationState;
  const utilityModel = application.snapshot().utilityModel;
  if (!utilityModel) return {};
  const title = yield* mapProjectError(
    "generateSessionTitle",
    generateUtilitySessionTitle({
      selection: utilityModelSelection(utilityModel),
      firstUserMessage: request.firstUserMessage,
    }),
  );
  return title === undefined ? {} : { title };
});

export const setUtilityModel = Effect.fn("Projects.setUtilityModel")(function* (
  _connectionId: number,
  request: Payload<"set-utility-model">,
) {
  return {
    state: yield* mapProjectError("setUtilityModel", setApplicationUtilityModel(request.model)),
  };
});

export const loadStagedSlashCommands = Effect.fn("Projects.loadStagedSlashCommands")(function* (
  _connectionId: number,
  request: Payload<"load-staged-slash-commands">,
) {
  yield* requireAllowed(request.path);
  const application = yield* ApplicationState;
  const resources = yield* PiAgentResources;
  const { skills, promptTemplates } = yield* mapProjectError(
    "loadStagedSlashCommands",
    resources.loadPromptResources({
      workingDirectory: request.path,
      projectTrusted: application.snapshot().trustedProjectPaths.includes(request.path),
    }),
  );
  return {
    commands: [
      ...promptTemplates.map((prompt) => ({
        name: prompt.name,
        description: prompt.description,
        ...(prompt.argumentHint ? { argumentHint: prompt.argumentHint } : undefined),
        source: "prompt" as const,
        sourceInfo: {
          path: prompt.path,
          source: prompt.source,
          scope: prompt.scope,
          origin: prompt.origin,
        },
      })),
      ...skills.map((skill) => ({
        name: `skill:${skill.name}`,
        description: skill.description,
        source: "skill" as const,
        sourceInfo: {
          path: skill.path,
          source: skill.source,
          scope: skill.scope,
          origin: skill.origin,
        },
      })),
    ],
  };
});

export const register = Effect.fn("Projects.register")(function* (
  _connectionId: number,
  request: Payload<"register-project">,
) {
  yield* requireAllowed(request.path);
  const application = yield* ApplicationState;
  const access = yield* ProjectAccess;
  const worktrees = yield* ManagedWorktrees;
  const records = yield* mapProjectError("registerProject", worktrees.records());
  if (records.some((entry) => entry.worktreePath === request.path))
    return { state: application.snapshot() };
  const state = yield* mapProjectError(
    "registerProject",
    upsertProject(request.path, request.name),
  );
  yield* Effect.forEach(
    records.filter((record) => record.projectPath === request.path),
    (record) => access.allow(record.worktreePath),
    { discard: true },
  );
  return { state };
});

export const rename = Effect.fn("Projects.rename")(function* (
  _connectionId: number,
  request: Payload<"rename-project">,
) {
  yield* requireAllowed(request.path);
  return {
    state: yield* mapProjectError("renameProject", renameProject(request.path, request.name)),
  };
});

export const setProjectSettings = Effect.fn("Projects.setProjectSettings")(function* (
  _connectionId: number,
  request: Payload<"set-project-settings">,
) {
  yield* requireAllowed(request.path);
  return {
    state: yield* mapProjectError(
      "setProjectSettings",
      setApplicationProjectSettings(request.path, request.settings),
    ),
  };
});

export const mutateWorkflow = Effect.fn("Projects.mutateWorkflow")(function* (request: {
  readonly projectPath: string;
  readonly mutation: ProjectWorkflowMutation;
}) {
  yield* requireAllowed(request.projectPath);
  return yield* mapProjectError(
    "mutateProjectWorkflow",
    mutateProjectWorkflow(request.projectPath, request.mutation),
  );
});

export const moveWorkflowSession = Effect.fn("Projects.moveWorkflowSession")(function* (request: {
  readonly projectPath: string;
  readonly sessionId: string;
  readonly workingDirectory: string;
  readonly destination: ProjectWorkflowSessionDestination;
}) {
  yield* requireAllowed(request.projectPath);
  return yield* mapProjectError(
    "moveProjectWorkflowSession",
    projectSessionLifecycle.moveWorkflowSession(request),
  );
});

export const describeWorkflowSession = Effect.fn("Projects.describeWorkflowSession")(
  function* (request: {
    readonly projectPath: string;
    readonly sessionId: string;
    readonly workingDirectory: string;
    readonly title: string;
    readonly firstUserMessage?: string;
  }) {
    yield* requireAllowed(request.projectPath);
    const application = yield* ApplicationState;
    const project = application
      .snapshot()
      .projects.find((candidate) => candidate.path === request.projectPath);
    if (!project)
      return yield* new ProjectError({
        operation: "describeWorkflowSession",
        message: "That Project is not registered",
      });
    const existing = (project.workflow ?? defaultProjectWorkflow()).sessionDetails.find(
      (details) => details.sessionId === request.sessionId,
    );
    if (existing?.description && existing.model) return existing;

    const preview = request.firstUserMessage
      ? undefined
      : yield* mapProjectError(
          "describeWorkflowSession",
          inspectProjectSession({
            sessionId: request.sessionId,
            workingDirectory: request.workingDirectory,
          }),
        );
    if (preview) {
      if (preview.projectPath !== request.projectPath)
        return yield* new ProjectError({
          operation: "describeWorkflowSession",
          message: "That session does not belong to this Project",
        });
    } else {
      const location = (yield* mapProjectError(
        "describeWorkflowSession",
        projectSessionLocations.locations(),
      )).find((candidate) => candidate.workingDirectory === request.workingDirectory);
      if (location?.projectPath !== request.projectPath)
        return yield* new ProjectError({
          operation: "describeWorkflowSession",
          message: "That Draft does not belong to this Project",
        });
    }
    const utilityModel = application.snapshot().utilityModel;
    const firstUserMessage = request.firstUserMessage ?? preview?.firstUserMessage;
    const generated =
      !existing?.description && utilityModel && firstUserMessage
        ? yield* Effect.result(
            generateUtilitySessionDescription({
              selection: utilityModelSelection(utilityModel),
              title: request.title,
              firstUserMessage,
            }),
          )
        : undefined;
    const details: ProjectWorkflowSessionDetails = {
      sessionId: request.sessionId,
      ...(existing?.model
        ? { model: existing.model }
        : preview?.model
          ? { model: preview.model }
          : undefined),
      ...(existing?.description
        ? { description: existing.description }
        : generated?._tag === "Success"
          ? { description: generated.success }
          : undefined),
    };
    return yield* mapProjectError(
      "describeWorkflowSession",
      setProjectWorkflowSessionDetails(request.projectPath, details),
    ).pipe(
      Effect.map(
        (workflow) =>
          workflow.sessionDetails.find((candidate) => candidate.sessionId === request.sessionId) ??
          details,
      ),
    );
  },
);

export const remove = Effect.fn("Projects.remove")(function* (
  _connectionId: number,
  request: Payload<"remove-project">,
) {
  yield* requireAllowed(request.path);
  const access = yield* ProjectAccess;
  const electron = yield* Electron;
  const integrations = yield* ProjectSessionRuntimeHost;
  const worktrees = yield* ManagedWorktrees;
  const records = yield* mapProjectError("removeProject", worktrees.records());
  const projectWorktrees = records.filter((record) => record.projectPath === request.path);
  if (request.deleteSessions)
    yield* mapProjectError(
      "removeProject",
      projectSessionLifecycle.deleteProjectSessions(request.path, projectWorktrees),
    );
  const workingDirectories = new Set([
    request.path,
    ...projectWorktrees.map((record) => record.worktreePath),
  ]);
  for (const workingDirectory of workingDirectories) {
    yield* mapProjectError("removeProject", access.revoke(workingDirectory));
    yield* mapProjectError("removeProject", integrations.stopWorkingDirectory(workingDirectory));
    electron.forgetWorkspace(workingDirectory);
  }
  yield* mapProjectError("removeProject", access.forgetWorkingDirectories(workingDirectories));
  return { state: yield* mapProjectError("removeProject", removeProject(request.path)) };
});

export const deleteSession = Effect.fn("Projects.deleteSession")(function* (
  _connectionId: number,
  request: Payload<"delete-session">,
) {
  const application = yield* ApplicationState;
  yield* mapProjectError(
    "deleteSession",
    projectSessionLifecycle.deleteResolved(request.sessionId),
  );
  return { state: application.snapshot() };
});

export const setSessionUnread = Effect.fn("Projects.setSessionUnread")(function* (
  _connectionId: number,
  request: Payload<"set-session-unread">,
) {
  const access = yield* ProjectAccess;
  const workingDirectory = yield* mapProjectError(
    "setSessionUnread",
    access.resolveSessionWorkingDirectory(request.sessionId),
  );
  const location = (yield* mapProjectError(
    "setSessionUnread",
    projectSessionLocations.locations(),
  )).find((candidate) => candidate.workingDirectory === workingDirectory);
  if (!location)
    return yield* new ProjectError({
      operation: "setSessionUnread",
      message: "Cake could not find that Project Session's Working Directory",
    });
  const archive = yield* SessionArchiveStorage;
  const namespace = yield* mapProjectError(
    "setSessionUnread",
    archive.locate(request.sessionId, {
      cwd: location.workingDirectory,
      activeRoot: location.sessionDirectory,
      resolvedRoot: location.resolvedSessionDirectory,
    }),
  );
  const state = yield* mapProjectError(
    "setSessionUnread",
    setApplicationSessionUnread(request.sessionId, request.unread),
  );
  const catalogs = yield* SessionCatalogChanges;
  yield* catalogs.publish({
    _tag: "ProjectSessionStatusChanged",
    sessionId: request.sessionId,
    projectPath: location.projectPath,
    workingDirectory,
    resolved: namespace === "resolved",
    unread: request.unread,
  });
  return { state };
});

export const activateWorkingDirectory = Effect.fn("Projects.activateWorkingDirectory")(function* (
  connectionId: number,
  workingDirectory: string,
) {
  const electron = yield* Electron;
  const sender = yield* requireConnection(connectionId, "activateWorkingDirectory");
  yield* requireAllowed(workingDirectory);
  electron.associateWorkspace(sender.id, workingDirectory);
});

export const restartPi = Effect.fn("Projects.restartPi")(function* (
  _connectionId: number,
  request: Payload<"restart-pi">,
) {
  yield* requireAllowed(request.path);
  const availability = yield* AgentAvailability;
  const sessions = yield* PiSessions;
  yield* availability.setWorkingDirectory(request.path, { state: "reloading" });
  yield* mapProjectError(
    "restartPi",
    sessions.reloadWorkingDirectory(request.path).pipe(
      Effect.tapError((error) =>
        availability.setWorkingDirectory(request.path, {
          state: "unavailable",
          reason: error.message,
        }),
      ),
    ),
  );
  yield* availability.setWorkingDirectory(request.path, { state: "available" });
  return { requestId: crypto.randomUUID() };
});

export const inspect = Effect.fn("Projects.inspect")(function* (
  connectionId: number,
  request: Payload<"inspect-workspace">,
) {
  const access = yield* ProjectAccess;
  const application = yield* ApplicationState;
  const electron = yield* Electron;
  const sender = yield* requireConnection(connectionId, "inspectWorkspace");
  yield* requireAllowed(request.path);
  const inspection = yield* Effect.try({
    try: () => inspectWorkspace(request.path),
    catch: (cause) => projectError("inspectWorkspace", cause),
  });
  const trustRequired =
    inspection.trustRequired && !application.snapshot().trustedProjectPaths.includes(request.path);
  yield* mapProjectError("inspectWorkspace", access.clearOwner(sender.id));
  electron.associateWorkspace(sender.id, request.path);
  if (trustRequired)
    yield* mapProjectError(
      "inspectWorkspace",
      access.requestTrust(sender.id, request.requestId, request.path),
    );
  return {
    requestId: request.requestId,
    path: request.path,
    trustRequired,
  };
});

export const respondTrust = Effect.fn("Projects.respondTrust")(function* (
  connectionId: number,
  request: Payload<"respond-workspace-trust">,
) {
  const access = yield* ProjectAccess;
  const sender = yield* requireConnection(connectionId, "respondTrust");
  yield* requireAllowed(request.path);
  yield* mapProjectError(
    "respondTrust",
    access.consumeTrustRequest(sender.id, request.requestId, request.path),
  );
  if (request.approved) yield* mapProjectError("respondTrust", trustProject(request.path));
  return { requestId: request.requestId };
});

/** Observes main-owned Project registration facts as a current-first renderer projection. */
export const observeCatalog = Effect.fn("Projects.observeCatalog")(function* () {
  const changes = yield* observeState();
  return changes.pipe(
    Stream.mapAccum(
      (): ProjectCatalogObservation => ({
        revision: 0,
        projects: undefined,
      }),
      (observation, projection) => {
        const projects = projection.state.projects.map((project) => ({ ...project }));
        if (observation.projects && sameProjects(observation.projects, projects))
          return [{ ...observation, projects }, []] as const;
        const revision = observation.revision + 1;
        const update: ProjectCatalogUpdate = observation.projects
          ? { _tag: "Event", revision, event: { _tag: "Replaced", projects } }
          : { _tag: "Snapshot", revision, projects };
        return [{ revision, projects }, [update]] as const;
      },
    ),
  );
});

const sameProjects = (left: ReadonlyArray<ProjectRecord>, right: ReadonlyArray<ProjectRecord>) =>
  left.length === right.length &&
  left.every((project, index) => {
    const other = right[index];
    return (
      other !== undefined &&
      project.path === other.path &&
      project.name === other.name &&
      project.addedAt === other.addedAt &&
      project.lastOpenedAt === other.lastOpenedAt &&
      JSON.stringify(project.settings) === JSON.stringify(other.settings) &&
      JSON.stringify(project.workflow) === JSON.stringify(other.workflow)
    );
  });
