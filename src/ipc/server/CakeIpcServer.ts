import { Duration, Effect, Layer, Stream } from "effect";
import { RpcServer } from "effect/unstable/rpc";
import { getState } from "../../domain/application";
import * as cakeChats from "../../domain/cakeChats";
import * as discussionSessions from "../../domain/discussionSessions";
import * as modelPresets from "../../domain/modelPresets";
import * as projectSessions from "../../domain/projectSessions";
import * as projects from "../../domain/projects";
import * as subagents from "../../domain/subagents";
import { PiModels } from "../../services/pi/PiModels";
import { CakeRpc, FoundationFailure } from "../protocol/CakeRpc";
import {
  RendererConnection,
  RendererConnectionMiddlewareLive,
} from "../protocol/RendererConnectionMiddleware";
import { ElectronRpcServerProtocolLive } from "../transport/ElectronRpcServerProtocol";
import type { ProjectSessionEnvironmentService } from "../../services/project-sessions/ProjectSessionEnvironment";
import type { CakeChatEnvironmentOperations } from "../../services/cake-chats/CakeChatEnvironment";
import type { DiscussionSessionEnvironmentService } from "../../services/discussion-sessions/DiscussionSessionEnvironment";
import type { SubagentEnvironmentService } from "../../services/subagents/SubagentEnvironment";
import { WindowStateStorage } from "../../services/storage/WindowStateStorage";
import {
  Artifacts,
  Electron,
  Filesystem,
  ManagedWorktrees,
  NativeEvents,
  Plugins,
  Terminals,
  VsCode,
  Workspaces,
  type NativeOperationError,
} from "../../services/native/NativeServices";
export interface CakeIpcServerOperations {
  readonly getHomeDirectory: () => string | Promise<string>;
  readonly projectSessions: ProjectSessionEnvironmentService;
  readonly cakeChats: CakeChatEnvironmentOperations;
  readonly discussionSessions: DiscussionSessionEnvironmentService;
  readonly subagents: SubagentEnvironmentService;
}

export const makeCakeIpcServerLive = (operations: CakeIpcServerOperations) => {
  // Phase-2 acceptance probes are main-Scope, in-memory diagnostics only. Each
  // request runs independently; RPC interruption and connection closure own cleanup.
  let activeDelays = 0;
  let activeStreams = 0;
  const withConnection = <Success, Requirements>(
    operation: (connectionId: number) => Effect.Effect<Success, NativeOperationError, Requirements>,
  ) =>
    Effect.gen(function* () {
      const connection = yield* RendererConnection;
      return yield* operation(connection.connectionId);
    });

  const handlers = CakeRpc.toLayer({
    "application.getHomeDirectory": () =>
      Effect.gen(function* () {
        yield* RendererConnection;
        return yield* Effect.promise(() => Promise.resolve(operations.getHomeDirectory()));
      }),
    "application.getState": () => getState(),
    "windowState.load": () => Effect.flatMap(WindowStateStorage, (storage) => storage.load()),
    "windowState.save": ({ snapshot }) =>
      Effect.flatMap(WindowStateStorage, (storage) => storage.save(snapshot)),
    "projects.observeCatalog": () => Stream.unwrap(projects.observeCatalog()),
    "models.list": () => Effect.flatMap(PiModels, (models) => models.list()),
    "models.refresh": () => Effect.flatMap(PiModels, (models) => models.refreshCatalog()),
    "modelPresets.list": () => modelPresets.list(),
    "modelPresets.create": (input) => modelPresets.create(input),
    "modelPresets.update": (input) => modelPresets.update(input),
    "modelPresets.remove": ({ id }) => modelPresets.remove(id),
    "modelPresets.setDefault": ({ id }) => modelPresets.setDefault(id),
    "modelPresets.resolve": ({ id }) => modelPresets.resolve(id),
    "cakeChats.list": () => cakeChats.list(),
    "cakeChats.observeCatalog": () => Stream.unwrap(cakeChats.observeCatalog()),
    "cakeChats.inspect": ({ sessionId }) => cakeChats.inspect(sessionId),
    "cakeChats.open": (target) => cakeChats.open(target),
    "cakeChats.observe": (target) => Stream.unwrap(cakeChats.observe(target)),
    "cakeChats.prompt": (input) => cakeChats.prompt(input),
    "cakeChats.abort": (target) => cakeChats.abort(target),
    "cakeChats.compact": ({ instructions, ...target }) => cakeChats.compact(target, instructions),
    "cakeChats.editMessage": (input) => cakeChats.editMessage(input),
    "cakeChats.applyConfiguration": ({ configuration, ...target }) =>
      cakeChats.applyConfiguration(target, configuration),
    "cakeChats.setModel": ({ provider, modelId, ...target }) =>
      cakeChats.setModel(target, provider, modelId),
    "cakeChats.setThinkingLevel": ({ level, ...target }) =>
      cakeChats.setThinkingLevel(target, level),
    "cakeChats.setFastMode": ({ enabled, ...target }) => cakeChats.setFastMode(target, enabled),
    "cakeChats.rename": ({ name, ...target }) => cakeChats.rename(target, name),
    "cakeChats.handoff": ({ entryId, prompt, resolveSource, ...target }) => {
      const input: Parameters<typeof cakeChats.handoff>[0] = { target, entryId };
      if (prompt !== undefined) Object.assign(input, { prompt });
      if (resolveSource !== undefined) Object.assign(input, { resolveSource });
      return cakeChats.handoff(input);
    },
    "cakeChats.resolve": (target) => cakeChats.resolve(target),
    "cakeChats.restore": (target) => cakeChats.restore(target),
    "cakeChats.deleteResolved": (target) => cakeChats.deleteResolved(target),
    "cakeChats.respondControl": ({ controlRequestId, result }) =>
      cakeChats.respondControl(controlRequestId, result),
    "discussionSessions.observeCatalog": (input) =>
      Stream.unwrap(discussionSessions.observeCatalog(input)),
    "discussionSessions.list": (input) => discussionSessions.list(input),
    "discussionSessions.create": (input) => discussionSessions.create(input),
    "discussionSessions.observe": (target) => Stream.unwrap(discussionSessions.observe(target)),
    "discussionSessions.prompt": (input) => discussionSessions.prompt(input),
    "discussionSessions.abort": (target) => discussionSessions.abort(target),
    "discussionSessions.setResolved": ({ resolved, ...target }) =>
      discussionSessions.setResolved(target, resolved),
    "projectSessions.list": () => projectSessions.list(),
    "projectSessions.observeCatalog": () => Stream.unwrap(projectSessions.observeCatalog()),
    "projectSessions.inspect": (target) => projectSessions.inspect(target),
    "projectSessions.start": (input) => projectSessions.start(input),
    "projectSessions.open": (target) => projectSessions.open(target),
    "projectSessions.observe": (target) => Stream.unwrap(projectSessions.observe(target)),
    "projectSessions.prompt": (input) => projectSessions.prompt(input),
    "projectSessions.steer": (input) => projectSessions.steer(input),
    "projectSessions.followUp": (input) => projectSessions.followUp(input),
    "projectSessions.abort": (target) => projectSessions.abort(target),
    "projectSessions.compact": ({ instructions, ...target }) =>
      projectSessions.compact(target, instructions),
    "projectSessions.editMessage": (input) => projectSessions.editMessage(input),
    "projectSessions.applyConfiguration": ({ configuration, ...target }) =>
      projectSessions.applyConfiguration(target, configuration),
    "projectSessions.setModel": ({ provider, modelId, ...target }) =>
      projectSessions.setModel(target, provider, modelId),
    "projectSessions.setThinkingLevel": ({ level, ...target }) =>
      projectSessions.setThinkingLevel(target, level),
    "projectSessions.setFastMode": ({ enabled, ...target }) =>
      projectSessions.setFastMode(target, enabled),
    "projectSessions.getChangelog": (target) => projectSessions.getChangelog(target),
    "projectSessions.navigate": ({ entryId, ...target }) =>
      projectSessions.navigate(target, entryId),
    "projectSessions.setPiSetting": ({ update, ...target }) =>
      projectSessions.setPiSetting(target, update),
    "projectSessions.reload": (target) => projectSessions.reload(target),
    "projectSessions.login": ({ provider, authType, ...target }) =>
      projectSessions.login(target, provider, authType),
    "projectSessions.logout": ({ provider, ...target }) => projectSessions.logout(target, provider),
    "projectSessions.handoff": ({ entryId, prompt, resolveSource, ...target }) => {
      const input: Parameters<typeof projectSessions.handoff>[0] = { target, entryId };
      if (prompt !== undefined) Object.assign(input, { prompt });
      if (resolveSource !== undefined) Object.assign(input, { resolveSource });
      return projectSessions.handoff(input);
    },
    "projectSessions.rename": ({ name, ...target }) => projectSessions.rename(target, name),
    "projectSessions.fork": ({
      entryId,
      destinationWorkingDirectory,
      resolveSource,
      ...target
    }) => {
      const input: Parameters<typeof projectSessions.fork>[0] = { target, entryId };
      if (destinationWorkingDirectory !== undefined)
        Object.assign(input, { destinationWorkingDirectory });
      if (resolveSource !== undefined) Object.assign(input, { resolveSource });
      return projectSessions.fork(input);
    },
    "projectSessions.resolve": (target) => projectSessions.resolve(target).pipe(Effect.asVoid),
    "projectSessions.restore": (target) => projectSessions.restore(target).pipe(Effect.asVoid),
    "subagents.observe": ({ parentSessionId }) => Stream.unwrap(subagents.observe(parentSessionId)),
    "subagents.steer": ({ parentSessionId, handleId, text }) =>
      subagents.steer(parentSessionId, handleId, text),
    "subagents.abort": ({ parentSessionId, handleId }) =>
      subagents.abort(parentSessionId, handleId),
    "subagents.close": ({ parentSessionId, handleId }) =>
      subagents.close(parentSessionId, handleId).pipe(Effect.asVoid),
    "electron.choose-project": (request) =>
      withConnection((connectionId) =>
        Effect.flatMap(Electron, (service) => service["choose-project"](connectionId, request)),
      ),
    "electron.open-external-url": (request) =>
      withConnection((connectionId) =>
        Effect.flatMap(Electron, (service) => service["open-external-url"](connectionId, request)),
      ),
    "electron.show-transcript-selection-context-menu": (request) =>
      withConnection((connectionId) =>
        Effect.flatMap(Electron, (service) =>
          service["show-transcript-selection-context-menu"](connectionId, request),
        ),
      ),
    "electron.show-composer-context-menu": (request) =>
      withConnection((connectionId) =>
        Effect.flatMap(Electron, (service) =>
          service["show-composer-context-menu"](connectionId, request),
        ),
      ),
    "electron.show-session-context-menu": (request) =>
      withConnection((connectionId) =>
        Effect.flatMap(Electron, (service) =>
          service["show-session-context-menu"](connectionId, request),
        ),
      ),
    "electron.show-project-context-menu": (request) =>
      withConnection((connectionId) =>
        Effect.flatMap(Electron, (service) =>
          service["show-project-context-menu"](connectionId, request),
        ),
      ),
    "filesystem.choose-attachments": (request) =>
      withConnection((connectionId) =>
        Effect.flatMap(Filesystem, (service) =>
          service["choose-attachments"](connectionId, request),
        ),
      ),
    "filesystem.suggest-files": (request) =>
      withConnection((connectionId) =>
        Effect.flatMap(Filesystem, (service) => service["suggest-files"](connectionId, request)),
      ),
    "filesystem.read-workspace-file": (request) =>
      withConnection((connectionId) =>
        Effect.flatMap(Filesystem, (service) =>
          service["read-workspace-file"](connectionId, request),
        ),
      ),
    "workspaces.reword-composer-selection": (request) =>
      withConnection((connectionId) =>
        Effect.flatMap(Workspaces, (service) =>
          service["reword-composer-selection"](connectionId, request),
        ),
      ),
    "workspaces.generate-session-title": (request) =>
      withConnection((connectionId) =>
        Effect.flatMap(Workspaces, (service) =>
          service["generate-session-title"](connectionId, request),
        ),
      ),
    "workspaces.set-utility-model": (request) =>
      withConnection((connectionId) =>
        Effect.flatMap(Workspaces, (service) =>
          service["set-utility-model"](connectionId, request),
        ),
      ),
    "workspaces.register-project": (request) =>
      withConnection((connectionId) =>
        Effect.flatMap(Workspaces, (service) => service["register-project"](connectionId, request)),
      ),
    "workspaces.rename-project": (request) =>
      withConnection((connectionId) =>
        Effect.flatMap(Workspaces, (service) => service["rename-project"](connectionId, request)),
      ),
    "workspaces.remove-project": (request) =>
      withConnection((connectionId) =>
        Effect.flatMap(Workspaces, (service) => service["remove-project"](connectionId, request)),
      ),
    "workspaces.delete-session": (request) =>
      withConnection((connectionId) =>
        Effect.flatMap(Workspaces, (service) => service["delete-session"](connectionId, request)),
      ),
    "workspaces.set-session-unread": (request) =>
      withConnection((connectionId) =>
        Effect.flatMap(Workspaces, (service) =>
          service["set-session-unread"](connectionId, request),
        ),
      ),
    "workspaces.restart-pi": (request) =>
      withConnection((connectionId) =>
        Effect.flatMap(Workspaces, (service) => service["restart-pi"](connectionId, request)),
      ),
    "managedWorktrees.create-worktree": (request) =>
      withConnection((connectionId) =>
        Effect.flatMap(ManagedWorktrees, (service) =>
          service["create-worktree"](connectionId, request),
        ),
      ),
    "managedWorktrees.get-worktree-status": (request) =>
      withConnection((connectionId) =>
        Effect.flatMap(ManagedWorktrees, (service) =>
          service["get-worktree-status"](connectionId, request),
        ),
      ),
    "managedWorktrees.land-worktree": (request) =>
      withConnection((connectionId) =>
        Effect.flatMap(ManagedWorktrees, (service) =>
          service["land-worktree"](connectionId, request),
        ),
      ),
    "terminals.open-terminal": (request) =>
      withConnection((connectionId) =>
        Effect.flatMap(Terminals, (service) => service["open-terminal"](connectionId, request)),
      ),
    "terminals.get-terminal-status": (request) =>
      withConnection((connectionId) =>
        Effect.flatMap(Terminals, (service) =>
          service["get-terminal-status"](connectionId, request),
        ),
      ),
    "vscode.get-embedded-editor-state": (request) =>
      withConnection((connectionId) =>
        Effect.flatMap(VsCode, (service) =>
          service["get-embedded-editor-state"](connectionId, request),
        ),
      ),
    "vscode.set-vscode-server-path": (request) =>
      withConnection((connectionId) =>
        Effect.flatMap(VsCode, (service) =>
          service["set-vscode-server-path"](connectionId, request),
        ),
      ),
    "artifacts.respond-artifact": (request) =>
      withConnection((connectionId) =>
        Effect.flatMap(Artifacts, (service) => service["respond-artifact"](connectionId, request)),
      ),
    "artifacts.respond-ui": (request) =>
      withConnection((connectionId) =>
        Effect.flatMap(Artifacts, (service) => service["respond-ui"](connectionId, request)),
      ),
    "artifacts.export-artifacts": (request) =>
      withConnection((connectionId) =>
        Effect.flatMap(Artifacts, (service) => service["export-artifacts"](connectionId, request)),
      ),
    "plugins.get-customization-state": (request) =>
      withConnection((connectionId) =>
        Effect.flatMap(Plugins, (service) =>
          service["get-customization-state"](connectionId, request),
        ),
      ),
    "plugins.get-plugin-authoring-reference": (request) =>
      withConnection((connectionId) =>
        Effect.flatMap(Plugins, (service) =>
          service["get-plugin-authoring-reference"](connectionId, request),
        ),
      ),
    "plugins.list-plugin-files": (request) =>
      withConnection((connectionId) =>
        Effect.flatMap(Plugins, (service) => service["list-plugin-files"](connectionId, request)),
      ),
    "plugins.create-plugin": (request) =>
      withConnection((connectionId) =>
        Effect.flatMap(Plugins, (service) => service["create-plugin"](connectionId, request)),
      ),
    "plugins.read-plugin-file": (request) =>
      withConnection((connectionId) =>
        Effect.flatMap(Plugins, (service) => service["read-plugin-file"](connectionId, request)),
      ),
    "plugins.write-plugin-file": (request) =>
      withConnection((connectionId) =>
        Effect.flatMap(Plugins, (service) => service["write-plugin-file"](connectionId, request)),
      ),
    "plugins.validate-customization": (request) =>
      withConnection((connectionId) =>
        Effect.flatMap(Plugins, (service) =>
          service["validate-customization"](connectionId, request),
        ),
      ),
    "plugins.activate-customization": (request) =>
      withConnection((connectionId) =>
        Effect.flatMap(Plugins, (service) =>
          service["activate-customization"](connectionId, request),
        ),
      ),
    "plugins.rollback-customization": (request) =>
      withConnection((connectionId) =>
        Effect.flatMap(Plugins, (service) =>
          service["rollback-customization"](connectionId, request),
        ),
      ),
    "plugins.use-factory-customization": (request) =>
      withConnection((connectionId) =>
        Effect.flatMap(Plugins, (service) =>
          service["use-factory-customization"](connectionId, request),
        ),
      ),
    "plugins.list-plugins": (request) =>
      withConnection((connectionId) =>
        Effect.flatMap(Plugins, (service) => service["list-plugins"](connectionId, request)),
      ),
    "plugins.set-plugin-enabled": (request) =>
      withConnection((connectionId) =>
        Effect.flatMap(Plugins, (service) => service["set-plugin-enabled"](connectionId, request)),
      ),
    "plugins.set-active-scene": (request) =>
      withConnection((connectionId) =>
        Effect.flatMap(Plugins, (service) => service["set-active-scene"](connectionId, request)),
      ),
    "plugins.delete-plugin": (request) =>
      withConnection((connectionId) =>
        Effect.flatMap(Plugins, (service) => service["delete-plugin"](connectionId, request)),
      ),
    "plugins.compile-inline-widget": (request) =>
      withConnection((connectionId) =>
        Effect.flatMap(Plugins, (service) =>
          service["compile-inline-widget"](connectionId, request),
        ),
      ),
    "plugins.repair-inline-widget": (request) =>
      withConnection((connectionId) =>
        Effect.flatMap(Plugins, (service) =>
          service["repair-inline-widget"](connectionId, request),
        ),
      ),
    "plugins.open-plugin-agent": (request) =>
      withConnection((connectionId) =>
        Effect.flatMap(Plugins, (service) => service["open-plugin-agent"](connectionId, request)),
      ),
    "plugins.prompt-plugin-agent": (request) =>
      withConnection((connectionId) =>
        Effect.flatMap(Plugins, (service) => service["prompt-plugin-agent"](connectionId, request)),
      ),
    "plugins.abort-plugin-agent": (request) =>
      withConnection((connectionId) =>
        Effect.flatMap(Plugins, (service) => service["abort-plugin-agent"](connectionId, request)),
      ),
    "plugins.detach-plugin-agent": (request) =>
      withConnection((connectionId) =>
        Effect.flatMap(Plugins, (service) => service["detach-plugin-agent"](connectionId, request)),
      ),
    "plugins.run-plugin-completion": (request) =>
      withConnection((connectionId) =>
        Effect.flatMap(Plugins, (service) =>
          service["run-plugin-completion"](connectionId, request),
        ),
      ),
    "plugins.cancel-plugin-completion": (request) =>
      withConnection((connectionId) =>
        Effect.flatMap(Plugins, (service) =>
          service["cancel-plugin-completion"](connectionId, request),
        ),
      ),
    "plugins.load-plugin-state": (request) =>
      withConnection((connectionId) =>
        Effect.flatMap(Plugins, (service) => service["load-plugin-state"](connectionId, request)),
      ),
    "plugins.save-plugin-state": (request) =>
      withConnection((connectionId) =>
        Effect.flatMap(Plugins, (service) => service["save-plugin-state"](connectionId, request)),
      ),
    "plugins.call-plugin-backend": (request) =>
      withConnection((connectionId) =>
        Effect.flatMap(Plugins, (service) => service["call-plugin-backend"](connectionId, request)),
      ),
    "plugins.cancel-plugin-backend-call": (request) =>
      withConnection((connectionId) =>
        Effect.flatMap(Plugins, (service) =>
          service["cancel-plugin-backend-call"](connectionId, request),
        ),
      ),
    "plugins.customization-rendered": (request) =>
      withConnection((connectionId) =>
        Effect.flatMap(Plugins, (service) =>
          service["customization-rendered"](connectionId, request),
        ),
      ),
    "plugins.customization-runtime-failed": (request) =>
      withConnection((connectionId) =>
        Effect.flatMap(Plugins, (service) =>
          service["customization-runtime-failed"](connectionId, request),
        ),
      ),
    "electron.set-fullscreen-surface-open": (request) =>
      withConnection((connectionId) =>
        Effect.flatMap(Electron, (service) =>
          service["set-fullscreen-surface-open"](connectionId, request),
        ),
      ),
    "workspaces.inspect-workspace": (request) =>
      withConnection((connectionId) =>
        Effect.flatMap(Workspaces, (service) =>
          service["inspect-workspace"](connectionId, request),
        ),
      ),
    "workspaces.respond-workspace-trust": (request) =>
      withConnection((connectionId) =>
        Effect.flatMap(Workspaces, (service) =>
          service["respond-workspace-trust"](connectionId, request),
        ),
      ),
    "managedWorktrees.discard-worktree": (request) =>
      withConnection((connectionId) =>
        Effect.flatMap(ManagedWorktrees, (service) =>
          service["discard-worktree"](connectionId, request),
        ),
      ),
    "terminals.write-terminal": (request) =>
      withConnection((connectionId) =>
        Effect.flatMap(Terminals, (service) => service["write-terminal"](connectionId, request)),
      ),
    "terminals.resize-terminal": (request) =>
      withConnection((connectionId) =>
        Effect.flatMap(Terminals, (service) => service["resize-terminal"](connectionId, request)),
      ),
    "terminals.close-terminal": (request) =>
      withConnection((connectionId) =>
        Effect.flatMap(Terminals, (service) => service["close-terminal"](connectionId, request)),
      ),
    "vscode.install-embedded-editor": (request) =>
      withConnection((connectionId) =>
        Effect.flatMap(VsCode, (service) =>
          service["install-embedded-editor"](connectionId, request),
        ),
      ),
    "vscode.open-embedded-editor": (request) =>
      withConnection((connectionId) =>
        Effect.flatMap(VsCode, (service) => service["open-embedded-editor"](connectionId, request)),
      ),
    "vscode.update-embedded-editor-bounds": (request) =>
      withConnection((connectionId) =>
        Effect.flatMap(VsCode, (service) =>
          service["update-embedded-editor-bounds"](connectionId, request),
        ),
      ),
    "vscode.reveal-in-embedded-editor": (request) =>
      withConnection((connectionId) =>
        Effect.flatMap(VsCode, (service) =>
          service["reveal-in-embedded-editor"](connectionId, request),
        ),
      ),
    "vscode.open-embedded-editor-source-control": (request) =>
      withConnection((connectionId) =>
        Effect.flatMap(VsCode, (service) =>
          service["open-embedded-editor-source-control"](connectionId, request),
        ),
      ),
    "vscode.update-embedded-editor-annotations": (request) =>
      withConnection((connectionId) =>
        Effect.flatMap(VsCode, (service) =>
          service["update-embedded-editor-annotations"](connectionId, request),
        ),
      ),
    "application.observeEvents": () =>
      Stream.unwrap(
        Effect.gen(function* () {
          const connection = yield* RendererConnection;
          return (yield* NativeEvents).application(connection.connectionId);
        }),
      ),
    "artifacts.observeEvents": () =>
      Stream.unwrap(
        Effect.gen(function* () {
          const connection = yield* RendererConnection;
          return (yield* NativeEvents).artifacts(connection.connectionId);
        }),
      ),
    "plugins.observeEvents": () =>
      Stream.unwrap(
        Effect.gen(function* () {
          const connection = yield* RendererConnection;
          return (yield* NativeEvents).plugins(connection.connectionId);
        }),
      ),
    "terminals.observeEvents": () =>
      Stream.unwrap(
        Effect.gen(function* () {
          const connection = yield* RendererConnection;
          return (yield* NativeEvents).terminals(connection.connectionId);
        }),
      ),
    "vscode.observeEvents": () =>
      Stream.unwrap(
        Effect.gen(function* () {
          const connection = yield* RendererConnection;
          return (yield* NativeEvents).vscode(connection.connectionId);
        }),
      ),
    "electron.observeSurfaceEvents": () =>
      Stream.unwrap(
        Effect.gen(function* () {
          const connection = yield* RendererConnection;
          return (yield* NativeEvents).surfaces(connection.connectionId);
        }),
      ),
    "foundation.typedFailure": () =>
      Effect.fail(new FoundationFailure({ message: "Schema-decoded foundation failure" })),
    "foundation.stream": ({ count, intervalMs }) =>
      Stream.fromEffect(
        Effect.acquireRelease(
          Effect.sync(() => {
            activeStreams += 1;
          }),
          () =>
            Effect.sync(() => {
              activeStreams -= 1;
            }),
        ),
      ).pipe(
        Stream.scoped,
        Stream.flatMap(() =>
          Stream.fromIterable(Array.from({ length: count }, (_, index) => index + 1)).pipe(
            Stream.mapEffect((value) =>
              Effect.sleep(Duration.millis(intervalMs)).pipe(Effect.as(value)),
            ),
          ),
        ),
      ),
    "foundation.delay": ({ durationMs }) =>
      Effect.acquireUseRelease(
        Effect.sync(() => {
          activeDelays += 1;
        }),
        () => Effect.sleep(Duration.millis(durationMs)),
        () =>
          Effect.sync(() => {
            activeDelays -= 1;
          }),
      ),
    "foundation.activeRequests": () =>
      Effect.succeed({ delays: activeDelays, streams: activeStreams }),
  });

  return RpcServer.layer(CakeRpc, { spanPrefix: "CakeIpcServer" }).pipe(
    Layer.provide(
      Layer.mergeAll(handlers, RendererConnectionMiddlewareLive, ElectronRpcServerProtocolLive),
    ),
  );
};
