import { Effect, Predicate } from "effect";
import { CakeIpcClient, type CakeIpcClientService } from "../../ipc/client/CakeIpcClient";
import { makeRendererClientCapabilities } from "./RendererClientCapabilities";
import type { RendererRuntime } from "../RendererRuntime";
import {
  RendererClientError,
  type RendererClient,
  type RendererCommandOptions,
} from "./RendererClient";

const errorTag = (error: unknown): string | undefined => {
  if (!Predicate.isObject(error) || !("_tag" in error)) return undefined;
  return Predicate.isString(error._tag) ? error._tag : undefined;
};

const errorMessage = (error: unknown): string => {
  if (error instanceof Error && error.message) return error.message;
  const tag = errorTag(error);
  return tag ? `Cake command failed (${tag})` : "Cake command failed";
};

const errorDetails = (error: unknown): string => {
  if (error instanceof Error) return error.stack ?? `${error.name}: ${error.message}`;
  return errorTag(error) ?? "Unknown renderer command failure";
};

const rendererError = (
  operation: string,
  error: unknown,
  signal?: AbortSignal,
): RendererClientError => {
  if (error instanceof RendererClientError) return error;
  if (signal?.aborted)
    return new RendererClientError(
      "interrupted",
      operation,
      "The operation was cancelled",
      `Interrupted RendererClient command: ${operation}`,
    );
  const tag = errorTag(error);
  const kind = tag?.includes("RpcClient") ? "transport" : tag ? "rejected" : "unexpected";
  return new RendererClientError(kind, operation, errorMessage(error), errorDetails(error));
};

/** Builds the Promise command adapter over the window's single renderer runtime. */
export function makeRendererClient(runtime: RendererRuntime): RendererClient {
  const withClient = <Success, Failure>(
    operation: (client: CakeIpcClientService) => Effect.Effect<Success, Failure>,
  ): Effect.Effect<Success, Failure, CakeIpcClient> => Effect.flatMap(CakeIpcClient, operation);

  const run = <Success, Failure>(
    operation: string,
    effect: Effect.Effect<Success, Failure, CakeIpcClient>,
    options?: RendererCommandOptions,
  ): Promise<Success> =>
    runtime
      .runPromise(effect, options?.signal ? { signal: options.signal } : undefined)
      .catch((error: unknown) => Promise.reject(rendererError(operation, error, options?.signal)));

  return {
    application: {
      getHomeDirectory: (options) =>
        run(
          "application.getHomeDirectory",
          withClient((client) => client.application.getHomeDirectory()),
          options,
        ),
      getState: (options) =>
        run(
          "application.getState",
          withClient((client) => client.application.getState()),
          options,
        ),
    },
    windowState: {
      load: (options) =>
        run(
          "windowState.load",
          withClient((client) => client.windowState.load()),
          options,
        ),
      save: (snapshot, options) =>
        run(
          "windowState.save",
          withClient((client) => client.windowState.save(snapshot)),
          options,
        ),
    },
    models: {
      list: (options) =>
        run(
          "models.list",
          withClient((client) =>
            client.models.list().pipe(
              Effect.map((models) =>
                models.map(({ supportedThinkingLevels, input, authTypes, ...model }) => ({
                  ...model,
                  availableThinkingLevels: [...supportedThinkingLevels],
                  input: [...input],
                  authTypes: [...authTypes],
                })),
              ),
            ),
          ),
          options,
        ),
      refresh: (options) =>
        run(
          "models.refresh",
          withClient((client) => client.models.refresh()),
          options,
        ),
    },
    modelPresets: {
      list: (options) =>
        run(
          "modelPresets.list",
          withClient((client) => client.modelPresets.list()),
          options,
        ),
      create: (input, options) =>
        run(
          "modelPresets.create",
          withClient((client) => client.modelPresets.create(input)),
          options,
        ),
      update: (input, options) =>
        run(
          "modelPresets.update",
          withClient((client) => client.modelPresets.update(input)),
          options,
        ),
      remove: (id, options) =>
        run(
          "modelPresets.remove",
          withClient((client) => client.modelPresets.remove(id)),
          options,
        ),
      setDefault: (id, options) =>
        run(
          "modelPresets.setDefault",
          withClient((client) => client.modelPresets.setDefault(id)),
          options,
        ),
      resolve: (id, options) =>
        run(
          "modelPresets.resolve",
          withClient((client) => client.modelPresets.resolve(id)),
          options,
        ),
    },
    projectSessions: {
      inspect: (target, options) =>
        run(
          "projectSessions.inspect",
          withClient((client) => client.projectSessions.inspect(target)),
          options,
        ),
      start: (input, options) =>
        run(
          "projectSessions.start",
          withClient((client) => client.projectSessions.start(input)),
          options,
        ),
      open: (target, options) =>
        run(
          "projectSessions.open",
          withClient((client) => client.projectSessions.open(target)),
          options,
        ),
      prompt: (input, options) =>
        run(
          "projectSessions.prompt",
          withClient((client) => client.projectSessions.prompt(input)),
          options,
        ),
      steer: (input, options) =>
        run(
          "projectSessions.steer",
          withClient((client) => client.projectSessions.steer(input)),
          options,
        ),
      followUp: (input, options) =>
        run(
          "projectSessions.followUp",
          withClient((client) => client.projectSessions.followUp(input)),
          options,
        ),
      abort: (target, options) =>
        run(
          "projectSessions.abort",
          withClient((client) => client.projectSessions.abort(target)),
          options,
        ),
      compact: (input, options) =>
        run(
          "projectSessions.compact",
          withClient((client) => client.projectSessions.compact(input)),
          options,
        ),
      editMessage: (input, options) =>
        run(
          "projectSessions.editMessage",
          withClient((client) => client.projectSessions.editMessage(input)),
          options,
        ),
      applyConfiguration: (input, options) =>
        run(
          "projectSessions.applyConfiguration",
          withClient((client) => client.projectSessions.applyConfiguration(input)),
          options,
        ),
      setModel: (input, options) =>
        run(
          "projectSessions.setModel",
          withClient((client) => client.projectSessions.setModel(input)),
          options,
        ),
      setThinkingLevel: (input, options) =>
        run(
          "projectSessions.setThinkingLevel",
          withClient((client) => client.projectSessions.setThinkingLevel(input)),
          options,
        ),
      setFastMode: (input, options) =>
        run(
          "projectSessions.setFastMode",
          withClient((client) => client.projectSessions.setFastMode(input)),
          options,
        ),
      getChangelog: (target, options) =>
        run(
          "projectSessions.getChangelog",
          withClient((client) => client.projectSessions.getChangelog(target)),
          options,
        ),
      navigate: (input, options) =>
        run(
          "projectSessions.navigate",
          withClient((client) => client.projectSessions.navigate(input)),
          options,
        ),
      setPiSetting: (input, options) =>
        run(
          "projectSessions.setPiSetting",
          withClient((client) => client.projectSessions.setPiSetting(input)),
          options,
        ),
      reload: (target, options) =>
        run(
          "projectSessions.reload",
          withClient((client) => client.projectSessions.reload(target)),
          options,
        ),
      login: (input, options) =>
        run(
          "projectSessions.login",
          withClient((client) => client.projectSessions.login(input)),
          options,
        ),
      logout: (input, options) =>
        run(
          "projectSessions.logout",
          withClient((client) => client.projectSessions.logout(input)),
          options,
        ),
      handoff: (input, options) =>
        run(
          "projectSessions.handoff",
          withClient((client) => client.projectSessions.handoff(input)),
          options,
        ),
      rename: (target, options) =>
        run(
          "projectSessions.rename",
          withClient((client) => client.projectSessions.rename(target)),
          options,
        ),
      fork: (input, options) =>
        run(
          "projectSessions.fork",
          withClient((client) => client.projectSessions.fork(input)),
          options,
        ),
      resolve: (target, options) =>
        run(
          "projectSessions.resolve",
          withClient((client) => client.projectSessions.resolve(target)),
          options,
        ),
      restore: (target, options) =>
        run(
          "projectSessions.restore",
          withClient((client) => client.projectSessions.restore(target)),
          options,
        ),
      respondControl: (sessionId, controlRequestId, result, options) =>
        run(
          "projectSessions.respondControl",
          withClient((client) =>
            client.projectSessions.respondControl(sessionId, controlRequestId, result),
          ),
          options,
        ),
    },
    cakeChats: {
      inspect: (sessionId, options) =>
        run(
          "cakeChats.inspect",
          withClient((client) => client.cakeChats.inspect(sessionId)),
          options,
        ),
      open: (target, options) =>
        run(
          "cakeChats.open",
          withClient((client) => client.cakeChats.open(target)),
          options,
        ),
      prompt: (input, options) =>
        run(
          "cakeChats.prompt",
          withClient((client) => client.cakeChats.prompt(input)),
          options,
        ),
      abort: (target, options) =>
        run(
          "cakeChats.abort",
          withClient((client) => client.cakeChats.abort(target)),
          options,
        ),
      compact: (input, options) =>
        run(
          "cakeChats.compact",
          withClient((client) => client.cakeChats.compact(input)),
          options,
        ),
      editMessage: (input, options) =>
        run(
          "cakeChats.editMessage",
          withClient((client) => client.cakeChats.editMessage(input)),
          options,
        ),
      applyConfiguration: (input, options) =>
        run(
          "cakeChats.applyConfiguration",
          withClient((client) => client.cakeChats.applyConfiguration(input)),
          options,
        ),
      setModel: (input, options) =>
        run(
          "cakeChats.setModel",
          withClient((client) => client.cakeChats.setModel(input)),
          options,
        ),
      setThinkingLevel: (input, options) =>
        run(
          "cakeChats.setThinkingLevel",
          withClient((client) => client.cakeChats.setThinkingLevel(input)),
          options,
        ),
      setFastMode: (input, options) =>
        run(
          "cakeChats.setFastMode",
          withClient((client) => client.cakeChats.setFastMode(input)),
          options,
        ),
      rename: (input, options) =>
        run(
          "cakeChats.rename",
          withClient((client) => client.cakeChats.rename(input)),
          options,
        ),
      handoff: (input, options) =>
        run(
          "cakeChats.handoff",
          withClient((client) => client.cakeChats.handoff(input)),
          options,
        ),
      resolve: (target, options) =>
        run(
          "cakeChats.resolve",
          withClient((client) => client.cakeChats.resolve(target)),
          options,
        ),
      restore: (target, options) =>
        run(
          "cakeChats.restore",
          withClient((client) => client.cakeChats.restore(target)),
          options,
        ),
      deleteResolved: (target, options) =>
        run(
          "cakeChats.deleteResolved",
          withClient((client) => client.cakeChats.deleteResolved(target)),
          options,
        ),
      respondControl: (controlRequestId, result, options) =>
        run(
          "cakeChats.respondControl",
          withClient((client) => client.cakeChats.respondControl(controlRequestId, result)),
          options,
        ),
    },
    discussionSessions: {
      list: (input, options) =>
        run(
          "discussionSessions.list",
          withClient((client) => client.discussionSessions.list(input)),
          options,
        ),
      create: (input, options) =>
        run(
          "discussionSessions.create",
          withClient((client) => client.discussionSessions.create(input)),
          options,
        ),
      prompt: (input, options) =>
        run(
          "discussionSessions.prompt",
          withClient((client) => client.discussionSessions.prompt(input)),
          options,
        ),
      abort: (target, options) =>
        run(
          "discussionSessions.abort",
          withClient((client) => client.discussionSessions.abort(target)),
          options,
        ),
      setResolved: (target, options) =>
        run(
          "discussionSessions.setResolved",
          withClient((client) => client.discussionSessions.setResolved(target)),
          options,
        ),
    },
    subagents: {
      steer: (input, options) =>
        run(
          "subagents.steer",
          withClient((client) => client.subagents.steer(input)),
          options,
        ),
      abort: (input, options) =>
        run(
          "subagents.abort",
          withClient((client) => client.subagents.abort(input)),
          options,
        ),
      close: (input, options) =>
        run(
          "subagents.close",
          withClient((client) => client.subagents.close(input)),
          options,
        ),
    },
    ...makeRendererClientCapabilities((operation, command, options) =>
      run(operation, withClient(command), options),
    ),
    foundation: {
      typedFailure: (options) =>
        run(
          "foundation.typedFailure",
          withClient((client) => client.foundation.typedFailure()),
          options,
        ),
      delay: (input, options) =>
        run(
          "foundation.delay",
          withClient((client) => client.foundation.delay(input)),
          options,
        ),
      activeRequests: (options) =>
        run(
          "foundation.activeRequests",
          withClient((client) => client.foundation.activeRequests()),
          options,
        ),
    },
  };
}
