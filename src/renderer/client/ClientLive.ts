import { Effect, Predicate, Schema, Stream } from "effect";
import { ProjectSessionResolutionDomainFailure } from "../../contracts/project-sessions/project-session-resolution";
import { CakeIpcClient, type CakeIpcClientService } from "../../ipc/client/CakeIpcClient";
import { makeClientCapabilities } from "./ClientCapabilities";
import { makeCommandGroup } from "./command-group";
import type { Runtime } from "../runtime";
import { ClientError, type Client, type ClientCommandOptions } from "./Client";
import type { Attachment } from "../../ipc/session-contract";
import type { BrowserFiles } from "./BrowserFiles";
import { browserFileChunk } from "./BrowserFiles";
import type { BrowserMenuStore } from "../stores/BrowserMenuStore";
import { browserMenus } from "./BrowserMenus";
import { resolvedColorTheme } from "../lib/resolved-color-theme";

const isolatedEditorUrl = (lease: {
  id: string;
  endpoint: string;
  editorPort?: number;
  editorOrigin?: string;
}): string => {
  const app = new URL(window.location.href);
  if (
    !/^\/editor\/[1-9][0-9]*\/[a-f0-9]{64}\/$/.test(lease.endpoint) ||
    lease.endpoint.split("/")[3] !== lease.id
  )
    throw new Error("Invalid isolated editor lease endpoint");

  if (app.protocol === "https:") {
    if (!lease.editorOrigin)
      throw new Error("Browser VS Code requires a configured public HTTPS editor origin");
    let origin: URL;
    try {
      origin = new URL(lease.editorOrigin);
    } catch {
      throw new Error("Invalid public HTTPS editor origin");
    }
    if (
      origin.protocol !== "https:" ||
      lease.editorOrigin !== origin.origin ||
      origin.origin === app.origin ||
      origin.username ||
      origin.password ||
      origin.search ||
      origin.hash
    )
      throw new Error("Invalid public HTTPS editor origin: it must differ from Cake's origin");
    return `${origin.origin}${lease.endpoint}`;
  }

  const port = lease.editorPort;
  if (
    app.protocol !== "http:" ||
    !Number.isInteger(port) ||
    port === undefined ||
    port < 1 ||
    port > 65535 ||
    String(port) === app.port
  )
    throw new Error("Invalid isolated editor lease port");
  const editor = new URL(app.href);
  editor.port = String(port);
  editor.pathname = lease.endpoint;
  editor.search = "";
  editor.hash = "";
  if (editor.origin === app.origin) throw new Error("Editor origin must differ from Cake");
  return editor.href;
};

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
  const domainFailure = Schema.decodeUnknownResult(ProjectSessionResolutionDomainFailure)(error);
  if (domainFailure._tag === "Success")
    return new ClientError(
      "rejected",
      operation,
      domainFailure.success.message,
      errorDetails(error),
      {
        domainFailure: domainFailure.success,
      },
    );
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
    | {
        kind: "browser";
        connected(): boolean;
        blocked(): boolean;
        uncertain(operation: string): void;
        openExternalUrl(url: string): Promise<void>;
        files: BrowserFiles;
        menus: BrowserMenuStore;
        saveDrawExport(input: Parameters<Client["electron"]["saveDrawExport"]>[0]): Promise<string>;
        showNotification(
          input: Parameters<Client["electron"]["showNotification"]>[0],
        ): Promise<void>;
        setFullscreenSurfaceOpen(surfaceId: string, open: boolean): Promise<void>;
      }
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
      if ((host?.kind !== "remote" && host?.kind !== "browser") || !attachments?.length)
        return yield* send(attachments ?? []);
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
            : host.kind === "browser"
              ? host.files.get(attachment.path).size
              : (yield* client.filesystem["read-selected-file"]({
                  path: attachment.path,
                  offset: 0,
                })).size;
          const { id } = yield* client.attachmentUploads.open(
            image
              ? { kind: "image", name: attachment.name, size, mimeType: attachment.mimeType }
              : { kind: "file", name: attachment.name, size },
          );
          ids.push(id);
          if (image) {
            for (let offset = 0; offset < size;) {
              const data = attachment.data.slice((offset / 3) * 4, (offset / 3) * 4 + 262_144);
              yield* client.attachmentUploads.chunk({ id, offset, data });
              offset +=
                Math.floor((data.length * 3) / 4) -
                (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);
            }
          } else {
            for (let offset = 0; offset < size;) {
              const { data, size: currentSize } =
                host.kind === "browser"
                  ? {
                      data: yield* Effect.promise(() =>
                        browserFileChunk(host.files.get(attachment.path), offset),
                      ),
                      size: host.files.get(attachment.path).size,
                    }
                  : yield* client.filesystem["read-selected-file"]({
                      path: attachment.path,
                      offset,
                    });
              if (currentSize !== size) throw new Error("Selected file changed during transfer");
              yield* client.attachmentUploads.chunk({ id, offset, data });
              offset +=
                Math.floor((data.length * 3) / 4) -
                (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);
            }
          }
          const { reference } = yield* client.attachmentUploads.finish({ id });
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
            (id) => client.attachmentUploads.discard({ id }).pipe(Effect.ignore),
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
    const readOnly =
      /\.(get|list|read|inspect|catalog|effective|detail|history|compare|reference|load|suggest)/i.test(
        operation,
      ) ||
      /^(backendConnection\.connect|projectSessions\.open|cakeChats\.open|modelPresets\.resolve)$/.test(
        operation,
      ) ||
      operation === "terminals.get-terminal-status" ||
      operation === "workspaces.post-process-dictation";
    const stop = /\.(abort|cancel)/i.test(operation);
    if (host?.kind === "browser") {
      if (
        /^(speechOutput|dictation|desktopHost|backendConnection|desktopSharing|electron|windowState|browser)\./.test(
          operation,
        ) ||
        operation === "filesystem.choose-attachments" ||
        operation === "filesystem.read-selected-file" ||
        operation === "widgets.capture-native-widget" ||
        /^(models|sessionChats)\.(login|logout)$/.test(operation)
      )
        return Promise.reject(
          new ClientError(
            "unsupported",
            operation,
            "This operation is unavailable in this browser",
            operation,
          ),
        );
      if (!host.connected())
        return Promise.reject(
          new ClientError("transport", operation, "Disconnected. No command was sent.", operation),
        );
      if (host.blocked() && !readOnly && !stop)
        return Promise.reject(
          new ClientError(
            "rejected",
            operation,
            "A command's delivery is uncertain. Check refreshed state and acknowledge before sending more commands.",
            operation,
          ),
        );
    }
    const native =
      /^(speechOutput|dictation|desktopHost|windowState|electron)\./.test(operation) ||
      operation === "filesystem.choose-attachments" ||
      (operation.startsWith("browser.") && operation !== "browser.acquire-browser-preview");
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
        (host?.kind === "remote" || host?.kind === "browser") &&
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
  const execute = <Success, Failure>(
    operation: string,
    command: (client: CakeIpcClientService) => Effect.Effect<Success, Failure>,
    options?: ClientCommandOptions,
  ) => run(operation, withClient(command), options);
  const commands = <Group extends keyof CakeIpcClientService>(group: Group) =>
    makeCommandGroup(group, execute);
  const capabilities = makeClientCapabilities(execute);
  if (host?.kind === "browser") {
    // Only a validated path on the separately bound editor port may become a frame URL.
    // Do not fall back to the application origin or expose the desktop view bridge.
    capabilities.vscode.open = async (workingDirectory, options) => {
      const lease = await run(
        "vscode.acquire",
        withClient((client) =>
          client.vscode.acquire({
            requestId: crypto.randomUUID(),
            workspacePath: workingDirectory,
            theme: resolvedColorTheme(),
          }),
        ),
        options,
      );
      try {
        return { id: lease.id, endpoint: isolatedEditorUrl(lease) };
      } catch (error) {
        await run(
          "vscode.release",
          withClient((client) => client.vscode.release(lease.id)),
        ).catch(() => undefined);
        throw new ClientError("rejected", "vscode.open", errorMessage(error), errorDetails(error));
      }
    };
    capabilities.vscode.install = () =>
      Promise.reject(
        new ClientError(
          "unsupported",
          "vscode.install",
          "Install code-server on the backend",
          "Browser installation unavailable",
        ),
      );
    capabilities.vscode.updateBounds = async () => undefined;
    capabilities.electron.openExternalUrl = (url) => host.openExternalUrl(url);
    capabilities.electron.saveDrawExport = (input) => host.saveDrawExport(input);
    capabilities.electron.showNotification = (input) => host.showNotification(input);
    capabilities.filesystem.chooseAttachments = () => host.files.choose();
    Object.assign(capabilities.electron, browserMenus(host.menus));
    capabilities.electron.setFullscreenSurfaceOpen = (surfaceId, open) =>
      host.setFullscreenSurfaceOpen(surfaceId, open);
  }

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
    speechOutput: {
      ...commands("speechOutput"),
      synthesize: (request, consume, options) =>
        run(
          "speechOutput.synthesize",
          withClient((client) =>
            client.speechOutput
              .synthesize(request)
              .pipe(
                Stream.runForEach((audio) =>
                  Effect.tryPromise({ try: () => consume(audio), catch: (error) => error }),
                ),
              ),
          ),
          options,
        ),
    },
    dictation: commands("dictation"),
    desktopHost: commands("desktopHost"),
    backendConnection: commands("backendConnection"),
    desktopSharing: commands("desktopSharing"),
    application: commands("application"),
    windowState: commands("windowState"),
    nonChatModels: commands("nonChatModels"),
    models: {
      ...commands("models"),
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
    },
    mcpSettings: commands("mcpSettings"),
    piSettings: commands("piSettings"),
    modelPresets: commands("modelPresets"),
    draw: commands("draw"),
    drawControl: commands("drawControl"),
    savedDrafts: commands("savedDrafts"),
    scheduledMessages: commands("scheduledMessages"),
    projectWorkflow: commands("projectWorkflow"),
    projectSessions: {
      ...commands("projectSessions"),
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
    },
    sessionChats: {
      ...commands("sessionChats"),
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
    },
    cakeChats: {
      ...commands("cakeChats"),
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
    },
    discussionSessions: commands("discussionSessions"),
    subagents: commands("subagents"),
    workflows: commands("workflows"),
    ...capabilities,
    foundation: commands("foundation"),
  };
}
