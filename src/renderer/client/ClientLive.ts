import { Effect, Predicate } from "effect";
import { CakeIpcClient, type CakeIpcClientService } from "../../ipc/client/CakeIpcClient";
import { makeClientCapabilities } from "./ClientCapabilities";
import type { Runtime } from "../runtime";
import { ClientError, type Client, type ClientCommandOptions } from "./Client";
import type { Attachment } from "../../ipc/session-contract";

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
export function makeClient(
  runtime: Pick<Runtime, "execute">,
  host?:
    | { kind: "browser"; connected(): boolean; openExternalUrl(url: string): Promise<void> }
    | {
        kind: "remote";
        connected(): boolean;
        uncertain(operation: string): void;
        blocked(): boolean;
      },
): Client {
  const withAttachments = <Success, Failure>(
    client: CakeIpcClientService,
    attachments: ReadonlyArray<Attachment> | undefined,
    send: (attachments: ReadonlyArray<Attachment>) => Effect.Effect<Success, Failure>,
  ) =>
    Effect.gen(function* () {
      if (host?.kind !== "remote" || !attachments?.length) return yield* send(attachments ?? []);
      const ids: string[] = [];
      const prepare = Effect.gen(function* () {
        const prepared: Attachment[] = [];
        // Only selected device files and image bytes cross this boundary. Source/browser
        // references retain their existing backend semantics and require no upload.
        for (const attachment of attachments) {
          if (attachment.kind !== "file" && attachment.kind !== "image") {
            prepared.push(attachment);
            continue;
          }
          const image = attachment.kind === "image";
          const size = image
            ? Math.floor((attachment.data.length * 3) / 4) -
              (attachment.data.endsWith("==") ? 2 : attachment.data.endsWith("=") ? 1 : 0)
            : (yield* client.filesystem["read-selected-file"]({ path: attachment.path, offset: 0 }))
                .size;
          const { id } = yield* client.attachmentUploads["upload-open"](
            image
              ? { kind: "image", name: attachment.name, size, mimeType: attachment.mimeType }
              : { kind: "file", name: attachment.name, size },
          );
          ids.push(id);
          if (image) {
            for (let offset = 0; offset < size;) {
              const data = attachment.data.slice((offset / 3) * 4, (offset / 3) * 4 + 262_144);
              yield* client.attachmentUploads["upload-chunk"]({ id, offset, data });
              offset +=
                Math.floor((data.length * 3) / 4) -
                (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);
            }
          } else {
            for (let offset = 0; offset < size;) {
              const { data, size: currentSize } = yield* client.filesystem["read-selected-file"]({
                path: attachment.path,
                offset,
              });
              if (currentSize !== size) throw new Error("Selected file changed during transfer");
              yield* client.attachmentUploads["upload-chunk"]({ id, offset, data });
              offset +=
                Math.floor((data.length * 3) / 4) -
                (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);
            }
          }
          const { reference } = yield* client.attachmentUploads["upload-finish"]({ id });
          prepared.push(
            image
              ? {
                  kind: "image",
                  name: attachment.name,
                  mimeType: attachment.mimeType,
                  data: reference,
                }
              : { kind: "file", name: attachment.name, path: reference },
          );
        }
        return prepared;
      });
      const prepared = yield* prepare.pipe(
        Effect.onError(() =>
          Effect.forEach(
            ids,
            (id) => client.attachmentUploads["upload-discard"]({ id }).pipe(Effect.ignore),
            { discard: true },
          ),
        ),
      );
      // Never replay a turn on unknown receipt. A failure before send leaves the
      // original draft intact; disconnected or rejected unadmitted uploads expire.
      return yield* send(prepared);
    });

  const withClient = <Success, Failure>(
    operation: (client: CakeIpcClientService) => Effect.Effect<Success, Failure>,
  ): Effect.Effect<Success, Failure, CakeIpcClient> => Effect.flatMap(CakeIpcClient, operation);

  const run = <Success, Failure>(
    operation: string,
    effect: Effect.Effect<Success, Failure, CakeIpcClient>,
    options?: ClientCommandOptions,
  ): Promise<Success> => {
    if (host?.kind === "browser") {
      if (
        /^(dictation|desktopHost|backendConnection|desktopSharing|electron|windowState|vscode|browser|terminals|widgets|inlineWidgets|filesystem|managedWorktrees|draw|discussionSessions|subagents)\./.test(
          operation,
        ) ||
        /^(models|sessionChats)\.(login|logout)$/.test(operation)
      )
        return Promise.reject(
          new ClientError(
            "unsupported",
            operation,
            "This operation is available only in the desktop app",
            operation,
          ),
        );
      if (!host.connected())
        return Promise.reject(
          new ClientError("transport", operation, "Disconnected. No command was sent.", operation),
        );
    }
    const native =
      /^(dictation|desktopHost|windowState|electron)\./.test(operation) ||
      operation === "filesystem.choose-attachments" ||
      (operation.startsWith("browser.") && operation !== "browser.acquire-browser-preview");
    const readOnly =
      /\.(get|list|read|inspect|catalog|effective|detail|history|compare|reference|load|suggest)/i.test(
        operation,
      ) ||
      /^(backendConnection\.connect|projectSessions\.open|cakeChats\.open|modelPresets\.resolve)$/.test(
        operation,
      );
    const stop = /\.(abort|cancel)/i.test(operation);
    if (host?.kind === "remote" && !native) {
      if (operation.startsWith("desktopSharing."))
        return Promise.reject(
          new ClientError(
            "unsupported",
            operation,
            "This integration is not available with a remote backend yet",
            operation,
          ),
        );
      if (
        operation !== "backendConnection.connect" &&
        (!host.connected() || (host.blocked() && !readOnly && !stop))
      )
        return Promise.reject(
          new ClientError(
            "rejected",
            operation,
            host.blocked()
              ? "A command's delivery is uncertain. Check refreshed state and acknowledge before sending more commands."
              : "Disconnected. No command was sent.",
            operation,
          ),
        );
    }
    return runtime.execute(effect, options?.signal).catch((error: unknown) => {
      const failure = clientError(operation, error, options?.signal);
      if (
        host?.kind === "remote" &&
        !native &&
        !readOnly &&
        !stop &&
        (failure.kind === "transport" ||
          failure.kind === "unexpected" ||
          failure.kind === "interrupted")
      )
        host.uncertain(operation);
      throw failure;
    });
  };
  const capabilities = makeClientCapabilities((operation, command, options) =>
    run(operation, withClient(command), options),
  );
  if (host?.kind === "browser")
    capabilities.electron.openExternalUrl = (url) => host.openExternalUrl(url);

  if (host?.kind === "remote") {
    const open = capabilities.electron.openExternalUrl;
    capabilities.electron.openExternalUrl = (url, options) => {
      if (!/^https?:\/\//i.test(url) && !/^mailto:/i.test(url))
        return Promise.reject(
          new ClientError(
            "unsupported",
            "electron.openExternalUrl",
            "Remote files and custom-protocol links cannot be opened on this device",
            "Remote path blocked",
          ),
        );
      return open(url, options);
    };
    capabilities.electron.chooseProject = () =>
      Promise.reject(
        new ClientError(
          "unsupported",
          "electron.chooseProject",
          "Register remote projects on the server",
          "Local folder selection cannot select server paths",
        ),
      );
  }
  return {
    dictation: {
      install: (options) =>
        run(
          "dictation.install",
          withClient((client) => client.dictation.install()),
          options,
        ),
      setModelPath: (path, options) =>
        run(
          "dictation.setModelPath",
          withClient((client) => client.dictation.setModelPath(path)),
          options,
        ),
      remove: (options) =>
        run(
          "dictation.remove",
          withClient((client) => client.dictation.remove()),
          options,
        ),
      prepare: (options) =>
        run(
          "dictation.prepare",
          withClient((client) => client.dictation.prepare()),
          options,
        ),
      release: (options) =>
        run(
          "dictation.release",
          withClient((client) => client.dictation.release()),
          options,
        ),
      transcribe: (audio, options) =>
        run(
          "dictation.transcribe",
          withClient((client) => client.dictation.transcribe(audio)),
          options,
        ),
    },
    desktopHost: {
      current: (options) =>
        run(
          "desktopHost.current",
          withClient((client) => client.desktopHost.current()),
          options,
        ),
      select: (selection, options) =>
        run(
          "desktopHost.select",
          withClient((client) => client.desktopHost.select(selection)),
          options,
        ),
    },
    backendConnection: {
      connect: (input, options) =>
        run(
          "backendConnection.connect",
          withClient((client) => client.backendConnection.connect(input)),
          options,
        ),
    },
    desktopSharing: {
      configure: (input, options) =>
        run(
          "desktopSharing.configure",
          withClient((client) => client.desktopSharing.configure(input)),
          options,
        ),
    },
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
      setSessionPluginHidden: (input, options) =>
        run(
          "application.setSessionPluginHidden",
          withClient((client) => client.application.setSessionPluginHidden(input)),
          options,
        ),
      setSessionPluginState: (input, options) =>
        run(
          "application.setSessionPluginState",
          withClient((client) => client.application.setSessionPluginState(input)),
          options,
        ),
      setSessionPluginSharedState: (input, options) =>
        run(
          "application.setSessionPluginSharedState",
          withClient((client) => client.application.setSessionPluginSharedState(input)),
          options,
        ),
      deleteSessionPlugin: (input, options) =>
        run(
          "application.deleteSessionPlugin",
          withClient((client) => client.application.deleteSessionPlugin(input)),
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
    savedDrafts: {
      list: (options) =>
        run(
          "savedDrafts.list",
          withClient((client) => client.savedDrafts.list()),
          options,
        ),
      create: (input, options) =>
        run(
          "savedDrafts.create",
          withClient((client) => client.savedDrafts.create(input)),
          options,
        ),
      update: (record, expectedRevision, options) =>
        run(
          "savedDrafts.update",
          withClient((client) => client.savedDrafts.update(record, expectedRevision)),
          options,
        ),
      remove: (sessionId, expectedRevision, options) =>
        run(
          "savedDrafts.remove",
          withClient((client) => client.savedDrafts.remove(sessionId, expectedRevision)),
          options,
        ),
      recoverUncertain: (sessionId, expectedRevision, options) =>
        run(
          "savedDrafts.recoverUncertain",
          withClient((client) => client.savedDrafts.recoverUncertain(sessionId, expectedRevision)),
          options,
        ),
      activate: (input, options) =>
        run(
          "savedDrafts.activate",
          withClient((client) => client.savedDrafts.activate(input)),
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
          withClient((client) =>
            withAttachments(client, input.attachments, (attachments) =>
              client.projectSessions.start({ ...input, attachments }),
            ),
          ),
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
      callCakeOperation: (input, options) =>
        run(
          "projectSessions.callCakeOperation",
          withClient((client) => client.projectSessions.callCakeOperation(input)),
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
          withClient((client) =>
            withAttachments(client, input.attachments, (attachments) =>
              client.sessionChats.prompt({ ...input, attachments }),
            ),
          ),
          options,
        ),
      steer: (input, options) =>
        run(
          "sessionChats.steer",
          withClient((client) =>
            withAttachments(client, input.attachments, (attachments) =>
              client.sessionChats.steer({ ...input, attachments }),
            ),
          ),
          options,
        ),
      followUp: (input, options) =>
        run(
          "sessionChats.followUp",
          withClient((client) =>
            withAttachments(client, input.attachments, (attachments) =>
              client.sessionChats.followUp({ ...input, attachments }),
            ),
          ),
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
          withClient((client) =>
            withAttachments(client, input.attachments, (attachments) =>
              client.sessionChats.editMessage({ ...input, attachments }),
            ),
          ),
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
          withClient((client) =>
            withAttachments(client, input.attachments, (attachments) =>
              client.cakeChats.start({ ...input, attachments }),
            ),
          ),
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
    ...capabilities,
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
