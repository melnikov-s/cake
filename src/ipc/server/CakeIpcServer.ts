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

  const handlers = CakeRpc.toLayer({
    "application.getHomeDirectory": () =>
      Effect.gen(function* () {
        yield* RendererConnection;
        return yield* Effect.promise(() => Promise.resolve(operations.getHomeDirectory()));
      }),
    "application.getState": () => getState(),
    "projects.observeCatalog": () => Stream.unwrap(projects.observeCatalog()),
    "models.list": () => Effect.flatMap(PiModels, (models) => models.list()),
    "modelPresets.list": () => modelPresets.list(),
    "modelPresets.create": (input) => modelPresets.create(input),
    "modelPresets.update": (input) => modelPresets.update(input),
    "modelPresets.remove": ({ id }) => modelPresets.remove(id),
    "modelPresets.setDefault": ({ id }) => modelPresets.setDefault(id),
    "modelPresets.resolve": ({ id }) => modelPresets.resolve(id),
    "cakeChats.list": () => cakeChats.list(),
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
    "projectSessions.create": (input) => projectSessions.create(input),
    "projectSessions.open": (target) => projectSessions.open(target),
    "projectSessions.observe": (target) => Stream.unwrap(projectSessions.observe(target)),
    "projectSessions.prompt": (input) => projectSessions.prompt(input),
    "projectSessions.steer": (input) => projectSessions.steer(input),
    "projectSessions.followUp": (input) => projectSessions.followUp(input),
    "projectSessions.abort": (target) => projectSessions.abort(target),
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
