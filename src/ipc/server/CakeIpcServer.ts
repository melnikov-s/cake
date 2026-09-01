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
import { NativeCapabilities } from "../../services/native/NativeCapabilities";
import type { NativeEvent, NativeCommandResult } from "../native-contract";

function hasResponseType<Type extends NativeCommandResult["type"]>(
  response: NativeCommandResult,
  type: Type,
): response is Extract<NativeCommandResult, { readonly type: Type }> {
  return response.type === type;
}

type ObservedNativeEvent = NativeEvent | { readonly type: "native-stream-ready" };

function eventIs<const Types extends ReadonlyArray<ObservedNativeEvent["type"]>>(...types: Types) {
  const accepted = new Set<string>([...types, "native-stream-ready"]);
  return (
    event: ObservedNativeEvent,
  ): event is Extract<ObservedNativeEvent, { type: Types[number] | "native-stream-ready" }> =>
    accepted.has(event.type);
}

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
  const invokeNative = <Type extends NativeCommandResult["type"]>(
    request: Parameters<NativeCapabilities["Service"]["invoke"]>[1],
    expectedType: Type,
  ) =>
    Effect.gen(function* () {
      const connection = yield* RendererConnection;
      const capabilities = yield* NativeCapabilities;
      const response = yield* capabilities.invoke(connection.connectionId, request);
      if (!hasResponseType(response, expectedType))
        return yield* Effect.die(
          new Error(`Native operation returned ${response.type}; expected ${expectedType}`),
        );
      return response;
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
      invokeNative({ type: "choose-project", ...request }, "project-chosen"),
    "electron.open-external-url": (request) =>
      invokeNative({ type: "open-external-url", ...request }, "external-url-opened"),
    "electron.show-transcript-selection-context-menu": (request) =>
      invokeNative(
        { type: "show-transcript-selection-context-menu", ...request },
        "transcript-selection-context-menu-closed",
      ),
    "electron.show-composer-context-menu": (request) =>
      invokeNative(
        { type: "show-composer-context-menu", ...request },
        "composer-context-menu-closed",
      ),
    "electron.show-session-context-menu": (request) =>
      invokeNative(
        { type: "show-session-context-menu", ...request },
        "session-context-menu-closed",
      ),
    "electron.show-project-context-menu": (request) =>
      invokeNative(
        { type: "show-project-context-menu", ...request },
        "project-context-menu-closed",
      ),
    "filesystem.choose-attachments": (request) =>
      invokeNative({ type: "choose-attachments", ...request }, "attachments-chosen"),
    "filesystem.suggest-files": (request) =>
      invokeNative({ type: "suggest-files", ...request }, "file-suggestions"),
    "filesystem.read-workspace-file": (request) =>
      invokeNative({ type: "read-workspace-file", ...request }, "workspace-file"),
    "workspaces.reword-composer-selection": (request) =>
      invokeNative(
        { type: "reword-composer-selection", ...request },
        "composer-selection-reworded",
      ),
    "workspaces.generate-session-title": (request) =>
      invokeNative({ type: "generate-session-title", ...request }, "session-title-generated"),
    "workspaces.set-utility-model": (request) =>
      invokeNative({ type: "set-utility-model", ...request }, "application-state-updated"),
    "workspaces.register-project": (request) =>
      invokeNative({ type: "register-project", ...request }, "application-state-updated"),
    "workspaces.rename-project": (request) =>
      invokeNative({ type: "rename-project", ...request }, "application-state-updated"),
    "workspaces.remove-project": (request) =>
      invokeNative({ type: "remove-project", ...request }, "application-state-updated"),
    "workspaces.delete-session": (request) =>
      invokeNative({ type: "delete-session", ...request }, "application-state-updated"),
    "workspaces.set-session-unread": (request) =>
      invokeNative({ type: "set-session-unread", ...request }, "application-state-updated"),
    "workspaces.restart-pi": (request) =>
      invokeNative({ type: "restart-pi", ...request }, "accepted"),
    "managedWorktrees.create-worktree": (request) =>
      invokeNative({ type: "create-worktree", ...request }, "worktree-created"),
    "managedWorktrees.get-worktree-status": (request) =>
      invokeNative({ type: "get-worktree-status", ...request }, "worktree-status-loaded"),
    "managedWorktrees.land-worktree": (request) =>
      invokeNative({ type: "land-worktree", ...request }, "worktree-landed"),
    "terminals.open-terminal": (request) =>
      invokeNative({ type: "open-terminal", ...request }, "terminal-opened"),
    "terminals.get-terminal-status": (request) =>
      invokeNative({ type: "get-terminal-status", ...request }, "terminal-status"),
    "vscode.get-embedded-editor-state": (request) =>
      invokeNative(
        { type: "get-embedded-editor-state", ...request },
        "embedded-editor-state-loaded",
      ),
    "vscode.set-vscode-server-path": (request) =>
      invokeNative({ type: "set-vscode-server-path", ...request }, "application-state-updated"),
    "artifacts.respond-artifact": (request) =>
      invokeNative({ type: "respond-artifact", ...request }, "artifact-response-accepted"),
    "artifacts.respond-ui": (request) =>
      invokeNative({ type: "respond-ui", ...request }, "ui-response-accepted"),
    "artifacts.export-artifacts": (request) =>
      invokeNative({ type: "export-artifacts", ...request }, "artifacts-exported"),
    "plugins.get-customization-state": (request) =>
      invokeNative({ type: "get-customization-state", ...request }, "customization-state"),
    "plugins.get-plugin-authoring-reference": (request) =>
      invokeNative(
        { type: "get-plugin-authoring-reference", ...request },
        "plugin-authoring-reference",
      ),
    "plugins.list-plugin-files": (request) =>
      invokeNative({ type: "list-plugin-files", ...request }, "plugin-files"),
    "plugins.create-plugin": (request) =>
      invokeNative({ type: "create-plugin", ...request }, "plugin-files"),
    "plugins.read-plugin-file": (request) =>
      invokeNative({ type: "read-plugin-file", ...request }, "plugin-file"),
    "plugins.write-plugin-file": (request) =>
      invokeNative({ type: "write-plugin-file", ...request }, "plugin-files"),
    "plugins.validate-customization": (request) =>
      invokeNative({ type: "validate-customization", ...request }, "customization-validation"),
    "plugins.activate-customization": (request) =>
      invokeNative({ type: "activate-customization", ...request }, "customization-activation"),
    "plugins.rollback-customization": (request) =>
      invokeNative({ type: "rollback-customization", ...request }, "customization-state"),
    "plugins.use-factory-customization": (request) =>
      invokeNative({ type: "use-factory-customization", ...request }, "customization-state"),
    "plugins.list-plugins": (request) =>
      invokeNative({ type: "list-plugins", ...request }, "plugins-listed"),
    "plugins.set-plugin-enabled": (request) =>
      invokeNative({ type: "set-plugin-enabled", ...request }, "plugins-listed"),
    "plugins.set-active-scene": (request) =>
      invokeNative({ type: "set-active-scene", ...request }, "plugins-listed"),
    "plugins.delete-plugin": (request) =>
      invokeNative({ type: "delete-plugin", ...request }, "plugins-listed"),
    "plugins.compile-inline-widget": (request) =>
      invokeNative({ type: "compile-inline-widget", ...request }, "inline-widget-compiled"),
    "plugins.repair-inline-widget": (request) =>
      invokeNative({ type: "repair-inline-widget", ...request }, "inline-widget-repaired"),
    "plugins.open-plugin-agent": (request) =>
      invokeNative({ type: "open-plugin-agent", ...request }, "plugin-agent-snapshot"),
    "plugins.prompt-plugin-agent": (request) =>
      invokeNative({ type: "prompt-plugin-agent", ...request }, "plugin-agent-snapshot"),
    "plugins.abort-plugin-agent": (request) =>
      invokeNative({ type: "abort-plugin-agent", ...request }, "plugin-agent-snapshot"),
    "plugins.detach-plugin-agent": (request) =>
      invokeNative({ type: "detach-plugin-agent", ...request }, "plugin-agent-detached"),
    "plugins.run-plugin-completion": (request) =>
      invokeNative({ type: "run-plugin-completion", ...request }, "plugin-completion-result"),
    "plugins.cancel-plugin-completion": (request) =>
      invokeNative({ type: "cancel-plugin-completion", ...request }, "accepted"),
    "plugins.load-plugin-state": (request) =>
      invokeNative({ type: "load-plugin-state", ...request }, "plugin-state"),
    "plugins.save-plugin-state": (request) =>
      invokeNative({ type: "save-plugin-state", ...request }, "plugin-state"),
    "plugins.call-plugin-backend": (request) =>
      invokeNative({ type: "call-plugin-backend", ...request }, "plugin-backend-result"),
    "plugins.cancel-plugin-backend-call": (request) =>
      invokeNative({ type: "cancel-plugin-backend-call", ...request }, "accepted"),
    "plugins.customization-rendered": (request) =>
      invokeNative({ type: "customization-rendered", ...request }, "customization-state"),
    "plugins.customization-runtime-failed": (request) =>
      invokeNative({ type: "customization-runtime-failed", ...request }, "customization-state"),
    "electron.set-fullscreen-surface-open": (request) =>
      invokeNative({ type: "set-fullscreen-surface-open", ...request }, "accepted"),
    "workspaces.inspect-workspace": (request) =>
      invokeNative({ type: "inspect-workspace", ...request }, "accepted"),
    "workspaces.respond-workspace-trust": (request) =>
      invokeNative({ type: "respond-workspace-trust", ...request }, "accepted"),
    "managedWorktrees.discard-worktree": (request) =>
      invokeNative({ type: "discard-worktree", ...request }, "accepted"),
    "terminals.write-terminal": (request) =>
      invokeNative({ type: "write-terminal", ...request }, "accepted"),
    "terminals.resize-terminal": (request) =>
      invokeNative({ type: "resize-terminal", ...request }, "accepted"),
    "terminals.close-terminal": (request) =>
      invokeNative({ type: "close-terminal", ...request }, "accepted"),
    "vscode.install-embedded-editor": (request) =>
      invokeNative({ type: "install-embedded-editor", ...request }, "accepted"),
    "vscode.open-embedded-editor": (request) =>
      invokeNative({ type: "open-embedded-editor", ...request }, "accepted"),
    "vscode.update-embedded-editor-bounds": (request) =>
      invokeNative({ type: "update-embedded-editor-bounds", ...request }, "accepted"),
    "vscode.reveal-in-embedded-editor": (request) =>
      invokeNative({ type: "reveal-in-embedded-editor", ...request }, "accepted"),
    "vscode.open-embedded-editor-source-control": (request) =>
      invokeNative({ type: "open-embedded-editor-source-control", ...request }, "accepted"),
    "vscode.update-embedded-editor-annotations": (request) =>
      invokeNative({ type: "update-embedded-editor-annotations", ...request }, "accepted"),
    "application.observeEvents": () =>
      Stream.unwrap(
        Effect.gen(function* () {
          const connection = yield* RendererConnection;
          const capabilities = yield* NativeCapabilities;
          const events = capabilities.observe(connection.connectionId);
          return events.pipe(
            Stream.filter(
              eventIs(
                "pi-state",
                "workspace-inspected",
                "changelog-snapshot",
                "complete",
                "fatal",
                "application-state-changed",
                "notification",
              ),
            ),
          );
        }),
      ),
    "artifacts.observeEvents": () =>
      Stream.unwrap(
        Effect.gen(function* () {
          const connection = yield* RendererConnection;
          const capabilities = yield* NativeCapabilities;
          const events = capabilities.observe(connection.connectionId);
          return events.pipe(
            Stream.filter(eventIs("artifact-updated", "artifact-requested", "ui-request")),
          );
        }),
      ),
    "plugins.observeEvents": () =>
      Stream.unwrap(
        Effect.gen(function* () {
          const connection = yield* RendererConnection;
          const capabilities = yield* NativeCapabilities;
          const events = capabilities.observe(connection.connectionId);
          return events.pipe(
            Stream.filter(
              eventIs("plugin-backend-event", "customization-state-changed", "plugin-agent-event"),
            ),
          );
        }),
      ),
    "terminals.observeEvents": () =>
      Stream.unwrap(
        Effect.gen(function* () {
          const connection = yield* RendererConnection;
          const capabilities = yield* NativeCapabilities;
          const events = capabilities.observe(connection.connectionId);
          return events.pipe(
            Stream.filter(eventIs("terminal-data", "terminal-exited", "terminal-toggle-requested")),
          );
        }),
      ),
    "vscode.observeEvents": () =>
      Stream.unwrap(
        Effect.gen(function* () {
          const connection = yield* RendererConnection;
          const capabilities = yield* NativeCapabilities;
          const events = capabilities.observe(connection.connectionId);
          return events.pipe(
            Stream.filter(
              eventIs(
                "embedded-editor-state",
                "embedded-editor-selection",
                "embedded-editor-back-to-agent",
                "embedded-editor-annotation-opened",
                "embedded-editor-toggle-chat",
                "embedded-editor-selection-cleared",
                "embedded-editor-location-opened",
              ),
            ),
          );
        }),
      ),
    "electron.observeSurfaceEvents": () =>
      Stream.unwrap(
        Effect.gen(function* () {
          const connection = yield* RendererConnection;
          const capabilities = yield* NativeCapabilities;
          const events = capabilities.observe(connection.connectionId);
          return events.pipe(Stream.filter(eventIs("fullscreen-surface-close-requested")));
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
