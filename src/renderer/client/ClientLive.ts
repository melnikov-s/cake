import { Effect, Predicate } from "effect";
import { CakeIpcClient, type CakeIpcClientService } from "../../ipc/client/CakeIpcClient";
import { makeClientCapabilities } from "./ClientCapabilities";
import type { Runtime } from "../runtime";
import { ClientError, type Client, type ClientCommandOptions } from "./Client";

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

const clientError = (operation: string, error: unknown, signal?: AbortSignal): ClientError => {
  if (error instanceof ClientError) return error;
  if (signal?.aborted)
    return new ClientError(
      "interrupted",
      operation,
      "The operation was cancelled",
      `Interrupted Client command: ${operation}`,
    );
  const tag = errorTag(error);
  const kind = tag?.includes("RpcClient") ? "transport" : tag ? "rejected" : "unexpected";
  return new ClientError(kind, operation, errorMessage(error), errorDetails(error));
};

/** Builds the Promise command adapter over the window's single renderer runtime. */
export function makeClient(runtime: Pick<Runtime, "execute">): Client {
  const withClient = <Success, Failure>(
    operation: (client: CakeIpcClientService) => Effect.Effect<Success, Failure>,
  ): Effect.Effect<Success, Failure, CakeIpcClient> => Effect.flatMap(CakeIpcClient, operation);

  const run = <Success, Failure>(
    operation: string,
    effect: Effect.Effect<Success, Failure, CakeIpcClient>,
    options?: ClientCommandOptions,
  ): Promise<Success> =>
    runtime
      .execute(effect, options?.signal)
      .catch((error: unknown) => Promise.reject(clientError(operation, error, options?.signal)));

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
      login: (input, options) =>
        run(
          "models.login",
          withClient((client) => client.models.login(input)),
          options,
        ),
      logout: (input, options) =>
        run(
          "models.logout",
          withClient((client) => client.models.logout(input)),
          options,
        ),
    },
    piSettings: {
      get: (options) =>
        run(
          "piSettings.get",
          withClient((client) => client.piSettings.get()),
          options,
        ),
      update: (update, options) =>
        run(
          "piSettings.update",
          withClient((client) => client.piSettings.update(update)),
          options,
        ),
      reload: (options) =>
        run(
          "piSettings.reload",
          withClient((client) => client.piSettings.reload()),
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
      reorder: (input, options) =>
        run(
          "modelPresets.reorder",
          withClient((client) => client.modelPresets.reorder(input)),
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
    draw: {
      list: (input, options) =>
        run(
          "draw.list",
          withClient((client) => client.draw.list(input)),
          options,
        ),
      create: (input, options) =>
        run(
          "draw.create",
          withClient((client) => client.draw.create(input)),
          options,
        ),
      read: (input, options) =>
        run(
          "draw.read",
          withClient((client) => client.draw.read(input)),
          options,
        ),
      save: (input, options) =>
        run(
          "draw.save",
          withClient((client) => client.draw.save(input)),
          options,
        ),
      rename: (input, options) =>
        run(
          "draw.rename",
          withClient((client) => client.draw.rename(input)),
          options,
        ),
      delete: (input, options) =>
        run(
          "draw.delete",
          withClient((client) => client.draw.delete(input)),
          options,
        ),
    },
    drawControl: {
      respond: (input, options) =>
        run(
          "drawControl.respond",
          withClient((client) => client.drawControl.respond(input)),
          options,
        ),
    },
    scheduledMessages: {
      list: (targetSessionId, options) =>
        run(
          "scheduledMessages.list",
          withClient((client) => client.scheduledMessages.list(targetSessionId)),
          options,
        ),
      schedule: (input, options) =>
        run(
          "scheduledMessages.schedule",
          withClient((client) => client.scheduledMessages.schedule(input)),
          options,
        ),
      cancel: (id, options) =>
        run(
          "scheduledMessages.cancel",
          withClient((client) => client.scheduledMessages.cancel(id)),
          options,
        ),
    },
    projectWorkflow: {
      mutateGlobal: (input, options) =>
        run(
          "projectWorkflow.mutateGlobal",
          withClient((client) => client.projectWorkflow.mutateGlobal(input)),
          options,
        ),
      mutate: (input, options) =>
        run(
          "projectWorkflow.mutate",
          withClient((client) => client.projectWorkflow.mutate(input)),
          options,
        ),
      setSessionLabels: (input, options) =>
        run(
          "projectWorkflow.setSessionLabels",
          withClient((client) => client.projectWorkflow.setSessionLabels(input)),
          options,
        ),
      describeSession: (input, options) =>
        run(
          "projectWorkflow.describeSession",
          withClient((client) => client.projectWorkflow.describeSession(input)),
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
      dispatchExtensionCompanionAction: (input, options) =>
        run(
          "projectSessions.dispatchExtensionCompanionAction",
          withClient((client) => client.projectSessions.dispatchExtensionCompanionAction(input)),
          options,
        ),
      toolCompact: (input, options) =>
        run(
          "projectSessions.toolCompact",
          withClient((client) => client.projectSessions.toolCompact(input)),
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
      resolveWorkingDirectory: (input, options) =>
        run(
          "projectSessions.resolveWorkingDirectory",
          withClient((client) => client.projectSessions.resolveWorkingDirectory(input)),
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
    sessionChats: {
      prompt: (input, options) =>
        run(
          "sessionChats.prompt",
          withClient((client) => client.sessionChats.prompt(input)),
          options,
        ),
      steer: (input, options) =>
        run(
          "sessionChats.steer",
          withClient((client) => client.sessionChats.steer(input)),
          options,
        ),
      followUp: (input, options) =>
        run(
          "sessionChats.followUp",
          withClient((client) => client.sessionChats.followUp(input)),
          options,
        ),
      abort: (target, options) =>
        run(
          "sessionChats.abort",
          withClient((client) => client.sessionChats.abort(target)),
          options,
        ),
      listQueuedMessages: (target, options) =>
        run(
          "sessionChats.listQueuedMessages",
          withClient((client) => client.sessionChats.listQueuedMessages(target)),
          options,
        ),
      clearQueue: (target, options) =>
        run(
          "sessionChats.clearQueue",
          withClient((client) => client.sessionChats.clearQueue(target)),
          options,
        ),
      cancelSteering: (target, options) =>
        run(
          "sessionChats.cancelSteering",
          withClient((client) => client.sessionChats.cancelSteering(target)),
          options,
        ),
      removeQueuedMessage: (input, options) =>
        run(
          "sessionChats.removeQueuedMessage",
          withClient((client) => client.sessionChats.removeQueuedMessage(input)),
          options,
        ),
      steerQueuedMessage: (input, options) =>
        run(
          "sessionChats.steerQueuedMessage",
          withClient((client) => client.sessionChats.steerQueuedMessage(input)),
          options,
        ),
      sendQueuedMessageNow: (input, options) =>
        run(
          "sessionChats.sendQueuedMessageNow",
          withClient((client) => client.sessionChats.sendQueuedMessageNow(input)),
          options,
        ),
      compact: (input, options) =>
        run(
          "sessionChats.compact",
          withClient((client) => client.sessionChats.compact(input)),
          options,
        ),
      editMessage: (input, options) =>
        run(
          "sessionChats.editMessage",
          withClient((client) => client.sessionChats.editMessage(input)),
          options,
        ),
      setUserMessageMarkdown: (input, options) =>
        run(
          "sessionChats.setUserMessageMarkdown",
          withClient((client) => client.sessionChats.setUserMessageMarkdown(input)),
          options,
        ),
      applyConfiguration: (input, options) =>
        run(
          "sessionChats.applyConfiguration",
          withClient((client) => client.sessionChats.applyConfiguration(input)),
          options,
        ),
      setModel: (input, options) =>
        run(
          "sessionChats.setModel",
          withClient((client) => client.sessionChats.setModel(input)),
          options,
        ),
      setThinkingLevel: (input, options) =>
        run(
          "sessionChats.setThinkingLevel",
          withClient((client) => client.sessionChats.setThinkingLevel(input)),
          options,
        ),
      setFastMode: (input, options) =>
        run(
          "sessionChats.setFastMode",
          withClient((client) => client.sessionChats.setFastMode(input)),
          options,
        ),
      login: (input, options) =>
        run(
          "sessionChats.login",
          withClient((client) => client.sessionChats.login(input)),
          options,
        ),
      logout: (input, options) =>
        run(
          "sessionChats.logout",
          withClient((client) => client.sessionChats.logout(input)),
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
      start: (input, options) =>
        run(
          "cakeChats.start",
          withClient((client) => client.cakeChats.start(input)),
          options,
        ),
      rename: (input, options) =>
        run(
          "cakeChats.rename",
          withClient((client) => client.cakeChats.rename(input)),
          options,
        ),
      toolCompact: (input, options) =>
        run(
          "cakeChats.toolCompact",
          withClient((client) => client.cakeChats.toolCompact(input)),
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
      start: (input, options) =>
        run(
          "discussionSessions.start",
          withClient((client) => client.discussionSessions.start(input)),
          options,
        ),
      ensureSessionAssistant: (input, options) =>
        run(
          "discussionSessions.ensureSessionAssistant",
          withClient((client) => client.discussionSessions.ensureSessionAssistant(input)),
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
      prompt: (input, options) =>
        run(
          "subagents.prompt",
          withClient((client) => client.subagents.prompt(input)),
          options,
        ),
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
    ...makeClientCapabilities((operation, command, options) =>
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
