import { Duration, Effect, Layer, Schema, Stream } from "effect";
import { RpcServer } from "effect/unstable/rpc";
import { getState } from "../../domain/application";
import * as cakeChats from "../../domain/cakeChats";
import * as discussionSessions from "../../domain/discussionSessions";
import * as modelPresets from "../../domain/modelPresets";
import * as projectSessions from "../../domain/projectSessions";
import * as projects from "../../domain/projects";
import * as privileged from "../../domain/privileged";
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
import { piSettingUpdateSchema } from "../session-contract";
import { WindowStateStorage } from "../../services/storage/WindowStateStorage";
import type { PrivilegedCapabilities } from "../../services/privileged/PrivilegedCapabilities";
import type { PrivilegedResponse } from "../privileged-contract";

function hasResponseType<Type extends PrivilegedResponse["type"]>(
  response: PrivilegedResponse,
  type: Type,
): response is Extract<PrivilegedResponse, { readonly type: Type }> {
  return response.type === type;
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
  const invokePrivileged = <Type extends PrivilegedResponse["type"]>(
    request: Parameters<PrivilegedCapabilities["Service"]["invoke"]>[1],
    expectedType: Type,
  ) =>
    Effect.gen(function* () {
      const connection = yield* RendererConnection;
      const response = yield* privileged.invoke(connection.connectionId, request);
      if (!hasResponseType(response, expectedType))
        return yield* Effect.die(
          new Error(`Privileged operation returned ${response.type}; expected ${expectedType}`),
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
      projectSessions.setPiSetting(target, Schema.decodeUnknownSync(piSettingUpdateSchema)(update)),
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
    "electron.choose-project": ({ request }) => invokePrivileged(request, "project-chosen"),
    "electron.open-external-url": ({ request }) => invokePrivileged(request, "external-url-opened"),
    "electron.show-transcript-selection-context-menu": ({ request }) =>
      invokePrivileged(request, "transcript-selection-context-menu-closed"),
    "electron.show-composer-context-menu": ({ request }) =>
      invokePrivileged(request, "composer-context-menu-closed"),
    "electron.show-session-context-menu": ({ request }) =>
      invokePrivileged(request, "session-context-menu-closed"),
    "electron.show-project-context-menu": ({ request }) =>
      invokePrivileged(request, "project-context-menu-closed"),
    "filesystem.choose-attachments": ({ request }) =>
      invokePrivileged(request, "attachments-chosen"),
    "filesystem.suggest-files": ({ request }) => invokePrivileged(request, "file-suggestions"),
    "filesystem.read-workspace-file": ({ request }) => invokePrivileged(request, "workspace-file"),
    "workspaces.reword-composer-selection": ({ request }) =>
      invokePrivileged(request, "composer-selection-reworded"),
    "workspaces.generate-session-title": ({ request }) =>
      invokePrivileged(request, "session-title-generated"),
    "workspaces.set-utility-model": ({ request }) =>
      invokePrivileged(request, "application-state-updated"),
    "workspaces.register-project": ({ request }) =>
      invokePrivileged(request, "application-state-updated"),
    "workspaces.rename-project": ({ request }) =>
      invokePrivileged(request, "application-state-updated"),
    "workspaces.remove-project": ({ request }) =>
      invokePrivileged(request, "application-state-updated"),
    "workspaces.delete-session": ({ request }) =>
      invokePrivileged(request, "application-state-updated"),
    "workspaces.set-session-unread": ({ request }) =>
      invokePrivileged(request, "application-state-updated"),
    "workspaces.restart-pi": ({ request }) => invokePrivileged(request, "accepted"),
    "managedWorktrees.create-worktree": ({ request }) =>
      invokePrivileged(request, "worktree-created"),
    "managedWorktrees.get-worktree-status": ({ request }) =>
      invokePrivileged(request, "worktree-status-loaded"),
    "managedWorktrees.land-worktree": ({ request }) => invokePrivileged(request, "worktree-landed"),
    "terminals.open-terminal": ({ request }) => invokePrivileged(request, "terminal-opened"),
    "terminals.get-terminal-status": ({ request }) => invokePrivileged(request, "terminal-status"),
    "vscode.get-embedded-editor-state": ({ request }) =>
      invokePrivileged(request, "embedded-editor-state-loaded"),
    "vscode.set-vscode-server-path": ({ request }) =>
      invokePrivileged(request, "application-state-updated"),
    "artifacts.respond-artifact": ({ request }) =>
      invokePrivileged(request, "artifact-response-accepted"),
    "artifacts.respond-ui": ({ request }) => invokePrivileged(request, "ui-response-accepted"),
    "artifacts.export-artifacts": ({ request }) => invokePrivileged(request, "artifacts-exported"),
    "plugins.get-customization-state": ({ request }) =>
      invokePrivileged(request, "customization-state"),
    "plugins.get-plugin-authoring-reference": ({ request }) =>
      invokePrivileged(request, "plugin-authoring-reference"),
    "plugins.list-plugin-files": ({ request }) => invokePrivileged(request, "plugin-files"),
    "plugins.create-plugin": ({ request }) => invokePrivileged(request, "plugin-files"),
    "plugins.read-plugin-file": ({ request }) => invokePrivileged(request, "plugin-file"),
    "plugins.write-plugin-file": ({ request }) => invokePrivileged(request, "plugin-files"),
    "plugins.validate-customization": ({ request }) =>
      invokePrivileged(request, "customization-validation"),
    "plugins.activate-customization": ({ request }) =>
      invokePrivileged(request, "customization-activation"),
    "plugins.rollback-customization": ({ request }) =>
      invokePrivileged(request, "customization-state"),
    "plugins.use-factory-customization": ({ request }) =>
      invokePrivileged(request, "customization-state"),
    "plugins.list-plugins": ({ request }) => invokePrivileged(request, "plugins-listed"),
    "plugins.set-plugin-enabled": ({ request }) => invokePrivileged(request, "plugins-listed"),
    "plugins.set-active-scene": ({ request }) => invokePrivileged(request, "plugins-listed"),
    "plugins.delete-plugin": ({ request }) => invokePrivileged(request, "plugins-listed"),
    "plugins.compile-inline-widget": ({ request }) =>
      invokePrivileged(request, "inline-widget-compiled"),
    "plugins.repair-inline-widget": ({ request }) =>
      invokePrivileged(request, "inline-widget-repaired"),
    "plugins.open-plugin-agent": ({ request }) =>
      invokePrivileged(request, "plugin-agent-snapshot"),
    "plugins.prompt-plugin-agent": ({ request }) =>
      invokePrivileged(request, "plugin-agent-snapshot"),
    "plugins.abort-plugin-agent": ({ request }) =>
      invokePrivileged(request, "plugin-agent-snapshot"),
    "plugins.detach-plugin-agent": ({ request }) =>
      invokePrivileged(request, "plugin-agent-detached"),
    "plugins.run-plugin-completion": ({ request }) =>
      invokePrivileged(request, "plugin-completion-result"),
    "plugins.cancel-plugin-completion": ({ request }) => invokePrivileged(request, "accepted"),
    "plugins.load-plugin-state": ({ request }) => invokePrivileged(request, "plugin-state"),
    "plugins.save-plugin-state": ({ request }) => invokePrivileged(request, "plugin-state"),
    "plugins.call-plugin-backend": ({ request }) =>
      invokePrivileged(request, "plugin-backend-result"),
    "plugins.cancel-plugin-backend-call": ({ request }) => invokePrivileged(request, "accepted"),
    "plugins.customization-rendered": ({ request }) =>
      invokePrivileged(request, "customization-state"),
    "plugins.customization-runtime-failed": ({ request }) =>
      invokePrivileged(request, "customization-state"),
    "electron.set-fullscreen-surface-open": ({ request }) => invokePrivileged(request, "accepted"),
    "workspaces.inspect-workspace": ({ request }) => invokePrivileged(request, "accepted"),
    "workspaces.respond-workspace-trust": ({ request }) => invokePrivileged(request, "accepted"),
    "managedWorktrees.discard-worktree": ({ request }) => invokePrivileged(request, "accepted"),
    "terminals.write-terminal": ({ request }) => invokePrivileged(request, "accepted"),
    "terminals.resize-terminal": ({ request }) => invokePrivileged(request, "accepted"),
    "terminals.close-terminal": ({ request }) => invokePrivileged(request, "accepted"),
    "vscode.install-embedded-editor": ({ request }) => invokePrivileged(request, "accepted"),
    "vscode.open-embedded-editor": ({ request }) => invokePrivileged(request, "accepted"),
    "vscode.update-embedded-editor-bounds": ({ request }) => invokePrivileged(request, "accepted"),
    "vscode.reveal-in-embedded-editor": ({ request }) => invokePrivileged(request, "accepted"),
    "vscode.open-embedded-editor-source-control": ({ request }) =>
      invokePrivileged(request, "accepted"),
    "vscode.update-embedded-editor-annotations": ({ request }) =>
      invokePrivileged(request, "accepted"),
    "privileged.observe": () =>
      Stream.unwrap(
        Effect.gen(function* () {
          const connection = yield* RendererConnection;
          return yield* privileged.observe(connection.connectionId);
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
