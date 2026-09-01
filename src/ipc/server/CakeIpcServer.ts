import { Duration, Effect, Layer, Stream } from "effect";
import { RpcServer } from "effect/unstable/rpc";
import { getState } from "../../domain/application";
import * as artifacts from "../../domain/artifacts";
import * as cakeChats from "../../domain/cakeChats";
import * as discussionSessions from "../../domain/discussionSessions";
import * as embeddedEditor from "../../domain/embeddedEditor";
import * as managedWorktrees from "../../domain/managedWorktrees";
import * as modelPresets from "../../domain/modelPresets";
import * as projectSessions from "../../domain/projectSessions";
import * as projects from "../../domain/projects";
import * as sessionTerminals from "../../domain/sessionTerminals";
import * as subagents from "../../domain/subagents";
import { PiModels } from "../../services/pi/PiModels";
import { CakeRpc, FoundationFailure } from "../protocol/CakeRpc";
import {
  RendererConnection,
  RendererConnectionMiddlewareLive,
} from "../protocol/RendererConnectionMiddleware";
import { ElectronRpcServerProtocolLive } from "../transport/ElectronRpcServerProtocol";
import { WindowStateStorage } from "../../services/storage/WindowStateStorage";
import { WorkspaceFiles } from "../../services/filesystem/WorkspaceFiles";
import { Electron } from "../../services/electron/Electron";
import { NativeEvents } from "../../services/electron/NativeEvents";
import { PluginRuntime } from "../../services/plugins/PluginRuntime";
import { VsCodeServer } from "../../services/vscode/VsCodeServer";
import { ProjectAccess } from "../../services/projects/ProjectAccess";

export const makeCakeIpcServerLive = (homeDirectory: string) => {
  // Phase-2 acceptance probes are main-Scope, in-memory diagnostics only. Each
  // request runs independently; RPC interruption and connection closure own cleanup.
  let activeDelays = 0;
  let activeStreams = 0;
  const withConnection = <Success, Error, Requirements>(
    operation: (connectionId: number) => Effect.Effect<Success, Error, Requirements>,
  ) =>
    Effect.gen(function* () {
      const connection = yield* RendererConnection;
      return yield* operation(connection.connectionId);
    });

  const handlers = CakeRpc.toLayer({
    "application.getHomeDirectory": () =>
      Effect.gen(function* () {
        yield* RendererConnection;
        const access = yield* ProjectAccess;
        yield* access.allow(homeDirectory);
        return homeDirectory;
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
        Effect.flatMap(Electron, (service) => service.chooseProject(connectionId, request)),
      ),
    "electron.open-external-url": (request) =>
      withConnection((connectionId) =>
        Effect.flatMap(Electron, (service) => service.openExternalUrl(connectionId, request)),
      ),
    "electron.show-transcript-selection-context-menu": (request) =>
      withConnection((connectionId) =>
        Effect.flatMap(Electron, (service) =>
          service.showTranscriptSelectionContextMenu(connectionId, request),
        ),
      ),
    "electron.show-composer-context-menu": (request) =>
      withConnection((connectionId) =>
        Effect.flatMap(Electron, (service) =>
          service.showComposerContextMenu(connectionId, request),
        ),
      ),
    "electron.show-session-context-menu": (request) =>
      withConnection((connectionId) =>
        Effect.flatMap(Electron, (service) =>
          service.showSessionContextMenu(connectionId, request),
        ),
      ),
    "electron.show-project-context-menu": (request) =>
      withConnection((connectionId) =>
        Effect.flatMap(Electron, (service) =>
          service.showProjectContextMenu(connectionId, request),
        ),
      ),
    "filesystem.choose-attachments": (request) =>
      withConnection((connectionId) =>
        Effect.flatMap(WorkspaceFiles, (service) =>
          service.chooseAttachments(connectionId, request),
        ),
      ),
    "filesystem.suggest-files": (request) =>
      withConnection((connectionId) =>
        Effect.flatMap(WorkspaceFiles, (service) => service.suggestFiles(connectionId, request)),
      ),
    "filesystem.read-workspace-file": (request) =>
      withConnection((connectionId) =>
        Effect.flatMap(WorkspaceFiles, (service) => service.readFile(connectionId, request)),
      ),
    "workspaces.reword-composer-selection": (request) =>
      withConnection((connectionId) => projects.rewordComposerSelection(connectionId, request)),
    "workspaces.generate-session-title": (request) =>
      withConnection((connectionId) => projects.generateSessionTitle(connectionId, request)),
    "workspaces.set-utility-model": (request) =>
      withConnection((connectionId) => projects.setUtilityModel(connectionId, request)),
    "workspaces.register-project": (request) =>
      withConnection((connectionId) => projects.register(connectionId, request)),
    "workspaces.rename-project": (request) =>
      withConnection((connectionId) => projects.rename(connectionId, request)),
    "workspaces.remove-project": (request) =>
      withConnection((connectionId) => projects.remove(connectionId, request)),
    "workspaces.delete-session": (request) =>
      withConnection((connectionId) => projects.deleteSession(connectionId, request)),
    "workspaces.set-session-unread": (request) =>
      withConnection((connectionId) => projects.setSessionUnread(connectionId, request)),
    "workspaces.restart-pi": (request) =>
      withConnection((connectionId) => projects.restartPi(connectionId, request)),
    "managedWorktrees.create-worktree": (request) =>
      Effect.flatMap(RendererConnection, () =>
        managedWorktrees.create({
          projectPath: request.path,
          baseWorktreePath: request.baseWorktreePath,
          worktreeName: request.worktreeName,
          firstUserMessage: request.firstUserMessage,
        }),
      ).pipe(Effect.map((record) => ({ requestId: request.requestId, record }))),
    "managedWorktrees.get-worktree-status": (request) =>
      Effect.flatMap(RendererConnection, () => managedWorktrees.status(request.workspacePath)).pipe(
        Effect.map((status) => ({ status })),
      ),
    "managedWorktrees.land-worktree": (request) =>
      Effect.flatMap(RendererConnection, () =>
        managedWorktrees.land(request.workspacePath, request.request),
      ).pipe(Effect.map((result) => ({ requestId: request.requestId, result }))),
    "terminals.open-terminal": (request) =>
      Effect.flatMap(RendererConnection, ({ connectionId }) =>
        sessionTerminals.open(connectionId, request),
      ),
    "terminals.get-terminal-status": (request) =>
      Effect.flatMap(RendererConnection, ({ connectionId }) =>
        sessionTerminals.status(connectionId, request),
      ),
    "vscode.get-embedded-editor-state": () =>
      Effect.flatMap(VsCodeServer, (service) => service.state()),
    "vscode.set-vscode-server-path": (request) =>
      embeddedEditor.setServerPath(request.path).pipe(Effect.map((state) => ({ state }))),
    "artifacts.respond-artifact": (request) =>
      Effect.flatMap(RendererConnection, () => artifacts.respond(request)),
    "artifacts.respond-ui": (request) =>
      Effect.flatMap(RendererConnection, () => artifacts.respondUi(request)),
    "artifacts.export-artifacts": (request) =>
      Effect.flatMap(RendererConnection, () => artifacts.exportArtifacts(request)),
    "plugins.get-customization-state": (request) =>
      withConnection((connectionId) =>
        Effect.flatMap(PluginRuntime, (service) =>
          service["get-customization-state"](connectionId, request),
        ),
      ),
    "plugins.get-plugin-authoring-reference": (request) =>
      withConnection((connectionId) =>
        Effect.flatMap(PluginRuntime, (service) =>
          service["get-plugin-authoring-reference"](connectionId, request),
        ),
      ),
    "plugins.list-plugin-files": (request) =>
      withConnection((connectionId) =>
        Effect.flatMap(PluginRuntime, (service) =>
          service["list-plugin-files"](connectionId, request),
        ),
      ),
    "plugins.create-plugin": (request) =>
      withConnection((connectionId) =>
        Effect.flatMap(PluginRuntime, (service) => service["create-plugin"](connectionId, request)),
      ),
    "plugins.read-plugin-file": (request) =>
      withConnection((connectionId) =>
        Effect.flatMap(PluginRuntime, (service) =>
          service["read-plugin-file"](connectionId, request),
        ),
      ),
    "plugins.write-plugin-file": (request) =>
      withConnection((connectionId) =>
        Effect.flatMap(PluginRuntime, (service) =>
          service["write-plugin-file"](connectionId, request),
        ),
      ),
    "plugins.validate-customization": (request) =>
      withConnection((connectionId) =>
        Effect.flatMap(PluginRuntime, (service) =>
          service["validate-customization"](connectionId, request),
        ),
      ),
    "plugins.activate-customization": (request) =>
      withConnection((connectionId) =>
        Effect.flatMap(PluginRuntime, (service) =>
          service["activate-customization"](connectionId, request),
        ),
      ),
    "plugins.rollback-customization": (request) =>
      withConnection((connectionId) =>
        Effect.flatMap(PluginRuntime, (service) =>
          service["rollback-customization"](connectionId, request),
        ),
      ),
    "plugins.use-factory-customization": (request) =>
      withConnection((connectionId) =>
        Effect.flatMap(PluginRuntime, (service) =>
          service["use-factory-customization"](connectionId, request),
        ),
      ),
    "plugins.list-plugins": (request) =>
      withConnection((connectionId) =>
        Effect.flatMap(PluginRuntime, (service) => service["list-plugins"](connectionId, request)),
      ),
    "plugins.set-plugin-enabled": (request) =>
      withConnection((connectionId) =>
        Effect.flatMap(PluginRuntime, (service) =>
          service["set-plugin-enabled"](connectionId, request),
        ),
      ),
    "plugins.set-active-scene": (request) =>
      withConnection((connectionId) =>
        Effect.flatMap(PluginRuntime, (service) =>
          service["set-active-scene"](connectionId, request),
        ),
      ),
    "plugins.delete-plugin": (request) =>
      withConnection((connectionId) =>
        Effect.flatMap(PluginRuntime, (service) => service["delete-plugin"](connectionId, request)),
      ),
    "plugins.compile-inline-widget": (request) =>
      withConnection((connectionId) =>
        Effect.flatMap(PluginRuntime, (service) =>
          service["compile-inline-widget"](connectionId, request),
        ),
      ),
    "plugins.repair-inline-widget": (request) =>
      withConnection((connectionId) =>
        Effect.flatMap(PluginRuntime, (service) =>
          service["repair-inline-widget"](connectionId, request),
        ),
      ),
    "plugins.open-plugin-agent": (request) =>
      withConnection((connectionId) =>
        Effect.flatMap(PluginRuntime, (service) =>
          service["open-plugin-agent"](connectionId, request),
        ),
      ),
    "plugins.prompt-plugin-agent": (request) =>
      withConnection((connectionId) =>
        Effect.flatMap(PluginRuntime, (service) =>
          service["prompt-plugin-agent"](connectionId, request),
        ),
      ),
    "plugins.abort-plugin-agent": (request) =>
      withConnection((connectionId) =>
        Effect.flatMap(PluginRuntime, (service) =>
          service["abort-plugin-agent"](connectionId, request),
        ),
      ),
    "plugins.detach-plugin-agent": (request) =>
      withConnection((connectionId) =>
        Effect.flatMap(PluginRuntime, (service) =>
          service["detach-plugin-agent"](connectionId, request),
        ),
      ),
    "plugins.run-plugin-completion": (request) =>
      withConnection((connectionId) =>
        Effect.flatMap(PluginRuntime, (service) =>
          service["run-plugin-completion"](connectionId, request),
        ),
      ),
    "plugins.cancel-plugin-completion": (request) =>
      withConnection((connectionId) =>
        Effect.flatMap(PluginRuntime, (service) =>
          service["cancel-plugin-completion"](connectionId, request),
        ),
      ),
    "plugins.load-plugin-state": (request) =>
      withConnection((connectionId) =>
        Effect.flatMap(PluginRuntime, (service) =>
          service["load-plugin-state"](connectionId, request),
        ),
      ),
    "plugins.save-plugin-state": (request) =>
      withConnection((connectionId) =>
        Effect.flatMap(PluginRuntime, (service) =>
          service["save-plugin-state"](connectionId, request),
        ),
      ),
    "plugins.call-plugin-backend": (request) =>
      withConnection((connectionId) =>
        Effect.flatMap(PluginRuntime, (service) =>
          service["call-plugin-backend"](connectionId, request),
        ),
      ),
    "plugins.cancel-plugin-backend-call": (request) =>
      withConnection((connectionId) =>
        Effect.flatMap(PluginRuntime, (service) =>
          service["cancel-plugin-backend-call"](connectionId, request),
        ),
      ),
    "plugins.customization-rendered": (request) =>
      withConnection((connectionId) =>
        Effect.flatMap(PluginRuntime, (service) =>
          service["customization-rendered"](connectionId, request),
        ),
      ),
    "plugins.customization-runtime-failed": (request) =>
      withConnection((connectionId) =>
        Effect.flatMap(PluginRuntime, (service) =>
          service["customization-runtime-failed"](connectionId, request),
        ),
      ),
    "electron.set-fullscreen-surface-open": (request) =>
      withConnection((connectionId) =>
        Effect.flatMap(Electron, (service) =>
          service.setFullscreenSurfaceOpen(connectionId, request),
        ),
      ),
    "workspaces.inspect-workspace": (request) =>
      withConnection((connectionId) => projects.inspect(connectionId, request)),
    "workspaces.respond-workspace-trust": (request) =>
      withConnection((connectionId) => projects.respondTrust(connectionId, request)),
    "managedWorktrees.discard-worktree": (request) =>
      Effect.flatMap(RendererConnection, () =>
        managedWorktrees.discard(request.workspacePath, request.keepBranch),
      ).pipe(Effect.as({ requestId: request.requestId })),
    "terminals.write-terminal": (request) =>
      Effect.flatMap(RendererConnection, ({ connectionId }) =>
        sessionTerminals.write(connectionId, request),
      ),
    "terminals.resize-terminal": (request) =>
      Effect.flatMap(RendererConnection, ({ connectionId }) =>
        sessionTerminals.resize(connectionId, request),
      ),
    "terminals.close-terminal": (request) =>
      Effect.flatMap(RendererConnection, ({ connectionId }) =>
        sessionTerminals.close(connectionId, request),
      ),
    "vscode.install-embedded-editor": (request) =>
      Effect.flatMap(VsCodeServer, (service) => service.install(request)),
    "vscode.open-embedded-editor": (request) =>
      withConnection((connectionId) =>
        Effect.flatMap(VsCodeServer, (service) => service.open(connectionId, request)),
      ),
    "vscode.update-embedded-editor-bounds": (request) =>
      withConnection((connectionId) =>
        Effect.flatMap(VsCodeServer, (service) => service.updateBounds(connectionId, request)),
      ),
    "vscode.reveal-in-embedded-editor": (request) =>
      Effect.flatMap(VsCodeServer, (service) => service.reveal(request)),
    "vscode.open-embedded-editor-source-control": (request) =>
      Effect.flatMap(VsCodeServer, (service) => service.openSourceControl(request)),
    "vscode.update-embedded-editor-annotations": (request) =>
      Effect.flatMap(VsCodeServer, (service) => service.updateAnnotations(request)),
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
          const terminalEvents = yield* sessionTerminals.events(connection.connectionId);
          const nativeEvents = (yield* NativeEvents).terminals(connection.connectionId);
          return Stream.merge(terminalEvents, nativeEvents);
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
