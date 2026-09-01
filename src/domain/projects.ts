import type { WebContents } from "electron";
import { Effect, Stream } from "effect";
import type { NativeEvent, nativeOperationPayloadSchemas } from "../ipc/native-protocol";
import { NativeOperationError } from "../ipc/protocol/NativeOperationError";
import { Electron } from "../services/electron/Electron";
import { PiSessions } from "../services/pi/PiSessions";
import { ProjectSessionIntegrations } from "../services/pi/ProjectSessionIntegrations";
import { rewordSelectionWithProjectContext } from "../services/pi/runtime/rewording-agent";
import { inspectWorkspace } from "../services/pi/runtime/session-discovery";
import { ProjectSessionLifecycle } from "../services/project-sessions/ProjectSessionLifecycle";
import { ProjectAccess } from "../services/projects/ProjectAccess";
import { ProjectConfiguration } from "../services/projects/ProjectConfiguration";
import { RewordingRequests } from "../services/projects/RewordingRequests";
import { ApplicationState } from "../services/storage/ApplicationState";
import { ManagedWorktrees } from "../services/worktrees/ManagedWorktrees";
import { resolveRewordingWorkspace } from "../services/projects/rewording-workspace";
import type { ProjectCatalogUpdate } from "./catalog-data";
import {
  observeState,
  removeProject,
  renameProject,
  setSessionUnread as setApplicationSessionUnread,
  setUtilityModel as setApplicationUtilityModel,
  trustProject,
  upsertProject,
} from "./application";
import {
  dictationRewordingGuidance,
  generateSessionTitle as generateUtilitySessionTitle,
  REWORD_CHARACTER_LIMIT,
  rewordSelection,
  utilityModelSelection,
} from "./utilityWork";

type Payload<Type extends keyof typeof nativeOperationPayloadSchemas> =
  (typeof nativeOperationPayloadSchemas)[Type]["Type"];

const nativeError = (operation: string, cause: unknown) =>
  new NativeOperationError({
    message: `${operation}: ${cause instanceof Error ? cause.message : String(cause)}`,
  });

const mapNativeError = <A, E, R>(operation: string, effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.mapError((cause) => nativeError(operation, cause)));

const requireAllowed = Effect.fn("Projects.requireAllowed")(function* (workingDirectory: string) {
  const access = yield* ProjectAccess;
  if (!(yield* access.isAllowed(workingDirectory)))
    return yield* new NativeOperationError({
      message: "Project path was not selected by the user",
    });
});

const requireConnection = Effect.fn("Projects.requireConnection")(function* (
  connectionId: number,
  operation: string,
): Effect.fn.Return<WebContents, NativeOperationError, Electron> {
  const electron = yield* Electron;
  return yield* Effect.try({
    try: () => electron.requireRendererConnection(connectionId),
    catch: (cause) => nativeError(operation, cause),
  });
});

const resolveRewordingWorkingDirectory = Effect.fn("Projects.resolveRewordingWorkingDirectory")(
  function* (requested: string | undefined, active: string | undefined) {
    const access = yield* ProjectAccess;
    const allowed = yield* mapNativeError(
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
      catch: (cause) => nativeError("rewordComposerSelection", cause),
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
    return yield* new NativeOperationError({
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
          catch: (cause) => nativeError("rewordComposerSelection", cause),
        })
      : yield* mapNativeError(
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
  const title = yield* mapNativeError(
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
    state: yield* mapNativeError("setUtilityModel", setApplicationUtilityModel(request.model)),
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
  const records = yield* mapNativeError("registerProject", worktrees.records());
  if (records.some((entry) => entry.worktreePath === request.path))
    return { state: application.snapshot() };
  const state = yield* mapNativeError("registerProject", upsertProject(request.path, request.name));
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
    state: yield* mapNativeError("renameProject", renameProject(request.path, request.name)),
  };
});

export const remove = Effect.fn("Projects.remove")(function* (
  _connectionId: number,
  request: Payload<"remove-project">,
) {
  yield* requireAllowed(request.path);
  const access = yield* ProjectAccess;
  const electron = yield* Electron;
  const integrations = yield* ProjectSessionIntegrations;
  const lifecycle = yield* ProjectSessionLifecycle;
  const worktrees = yield* ManagedWorktrees;
  const records = yield* mapNativeError("removeProject", worktrees.records());
  const projectWorktrees = records.filter((record) => record.projectPath === request.path);
  if (request.deleteSessions)
    yield* mapNativeError(
      "removeProject",
      lifecycle.deleteProjectSessions(request.path, projectWorktrees),
    );
  const workingDirectories = new Set([
    request.path,
    ...projectWorktrees.map((record) => record.worktreePath),
  ]);
  for (const workingDirectory of workingDirectories) {
    yield* mapNativeError("removeProject", access.revoke(workingDirectory));
    yield* mapNativeError("removeProject", integrations.stopWorkingDirectory(workingDirectory));
    electron.forgetWorkspace(workingDirectory);
  }
  yield* mapNativeError("removeProject", access.forgetWorkingDirectories(workingDirectories));
  return { state: yield* mapNativeError("removeProject", removeProject(request.path)) };
});

export const deleteSession = Effect.fn("Projects.deleteSession")(function* (
  _connectionId: number,
  request: Payload<"delete-session">,
) {
  const application = yield* ApplicationState;
  const lifecycle = yield* ProjectSessionLifecycle;
  yield* mapNativeError("deleteSession", lifecycle.deleteResolvedProjectSession(request.sessionId));
  return { state: application.snapshot() };
});

export const setSessionUnread = Effect.fn("Projects.setSessionUnread")(function* (
  _connectionId: number,
  request: Payload<"set-session-unread">,
) {
  const electron = yield* Electron;
  const state = yield* mapNativeError(
    "setSessionUnread",
    setApplicationSessionUnread(request.sessionId, request.unread),
  );
  yield* Effect.sync(() =>
    electron.broadcast({ type: "application-state-changed", state } satisfies NativeEvent),
  );
  return { state };
});

export const restartPi = Effect.fn("Projects.restartPi")(function* (
  _connectionId: number,
  request: Payload<"restart-pi">,
) {
  yield* requireAllowed(request.path);
  const electron = yield* Electron;
  const sessions = yield* PiSessions;
  yield* Effect.sync(() =>
    electron.broadcast({ type: "pi-state", state: "starting", workspacePath: request.path }),
  );
  yield* mapNativeError(
    "restartPi",
    sessions
      .reloadWorkingDirectory(request.path)
      .pipe(
        Effect.tapError(() =>
          Effect.sync(() =>
            electron.broadcast({ type: "pi-state", state: "failed", workspacePath: request.path }),
          ),
        ),
      ),
  );
  yield* Effect.sync(() =>
    electron.broadcast({ type: "pi-state", state: "ready", workspacePath: request.path }),
  );
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
    catch: (cause) => nativeError("inspectWorkspace", cause),
  });
  const trustRequired =
    inspection.trustRequired && !application.snapshot().trustedProjectPaths.includes(request.path);
  yield* mapNativeError("inspectWorkspace", access.clearOwner(sender.id));
  electron.associateWorkspace(sender.id, request.path);
  if (trustRequired)
    yield* mapNativeError(
      "inspectWorkspace",
      access.requestTrust(sender.id, request.requestId, request.path),
    );
  electron.sendTo(sender, {
    type: "workspace-inspected",
    requestId: request.requestId,
    path: request.path,
    trustRequired,
  });
  return { requestId: request.requestId };
});

export const respondTrust = Effect.fn("Projects.respondTrust")(function* (
  connectionId: number,
  request: Payload<"respond-workspace-trust">,
) {
  const access = yield* ProjectAccess;
  const sender = yield* requireConnection(connectionId, "respondTrust");
  yield* requireAllowed(request.path);
  yield* mapNativeError(
    "respondTrust",
    access.consumeTrustRequest(sender.id, request.requestId, request.path),
  );
  if (request.approved) yield* mapNativeError("respondTrust", trustProject(request.path));
  return { requestId: request.requestId };
});

/** Observes main-owned Project registration facts as a current-first renderer projection. */
export const observeCatalog = Effect.fn("Projects.observeCatalog")(function* () {
  const changes = yield* observeState();
  let initialized = false;
  return changes.pipe(
    Stream.map((projection): ProjectCatalogUpdate => {
      const projects = projection.state.projects.map((project) => ({ ...project }));
      if (!initialized) {
        initialized = true;
        return { _tag: "Snapshot", revision: projection.revision, projects };
      }
      return {
        _tag: "Event",
        revision: projection.revision,
        event: { _tag: "Replaced", projects },
      };
    }),
  );
});
