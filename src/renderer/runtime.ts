import { Context, Effect, Layer, ManagedRuntime, Schedule, Stream } from "effect";
import { RpcClient, RpcClientError, RpcSerialization } from "effect/unstable/rpc";
import { Socket } from "effect/unstable/socket";
import {
  CakeIpcClient,
  CakeIpcClientLive,
  type CakeIpcClientService,
} from "../ipc/client/CakeIpcClient";
import { cakeBuildId } from "../ipc/protocol/BackendConnectionRpc";
import { BrowserError } from "../services/browser/Browser";
import { makeElectronRpcClientProtocol } from "../ipc/transport/ElectronRpcClientProtocol";
import type { ElectronRpcTransport } from "../ipc/transport/ElectronRpcTransport";
import {
  observeStream,
  type ExecuteRendererEffect,
  type StreamOptions,
} from "./observers/observe-stream";

const makeRendererLayer = (transport: ElectronRpcTransport) =>
  CakeIpcClientLive.pipe(Layer.provide(makeElectronRpcClientProtocol(transport)));

/** Shared native presentation policy for local and remote backend clients. */
const withEditorPresentation = Effect.fn("Renderer.withEditorPresentation")(function* (
  client: CakeIpcClientService,
) {
  yield* client.vscodeViews.observeThemes().pipe(
    Stream.runForEach((theme) =>
      client.vscode
        .setTheme(theme)
        .pipe(Effect.catch((error) => Effect.logWarning("Editor theme sync failed", error))),
    ),
    Effect.forkScoped,
  );
  return CakeIpcClient.of({
    ...client,
    events: {
      ...client.events,
      vscode: () =>
        client.events
          .vscode()
          .pipe(
            Stream.tap((event) =>
              event.type === "embedded-editor-annotation-opened" ||
              event.type === "embedded-editor-annotation-requested" ||
              event.type === "embedded-editor-side-chat-requested"
                ? client.vscodeViews.focusCake().pipe(Effect.ignore)
                : Effect.void,
            ),
          ),
    },
  });
});

/** Window-owned execution boundary; the ManagedRuntime never escapes this module. */
export const makeRuntime = (transport: ElectronRpcTransport) => {
  const layer = Layer.effect(
    CakeIpcClient,
    Effect.gen(function* () {
      const client = yield* CakeIpcClient;
      return yield* withEditorPresentation(client);
    }),
  ).pipe(Layer.provide(makeRendererLayer(transport)));
  const runtime = ManagedRuntime.make(layer);
  const execute: ExecuteRendererEffect = (effect, signal) =>
    runtime.runPromise(effect, signal ? { signal } : undefined);
  return {
    execute,
    observe: <Value>(
      source: (client: CakeIpcClientService) => Stream.Stream<Value, unknown>,
      consume: (value: Value) => void,
      options: StreamOptions,
    ) => observeStream(execute, source, consume, options),
    dispose: () => runtime.dispose(),
  };
};

export type Runtime = ReturnType<typeof makeRuntime>;

/** Tab-owned socket protocol. Only observations retry; commands are never replayed. */
const makeNetworkLayer = (
  url: string,
  onConnection: (connected: boolean) => void,
  disconnected: Effect.Effect<void> = Effect.void,
) => {
  const protocol = RpcClient.layerProtocolSocket({ retryTransientErrors: false }).pipe(
    Layer.provide(
      Layer.mergeAll(
        Socket.layerWebSocket(url).pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal)),
        RpcSerialization.layerJson,
        Layer.succeed(RpcClient.ConnectionHooks, {
          onConnect: Effect.sync(() => onConnection(true)),
          onDisconnect: Effect.sync(() => onConnection(false)).pipe(Effect.andThen(disconnected)),
        }),
      ),
    ),
  );
  return CakeIpcClientLive.pipe(Layer.provide(protocol));
};

export const makeNetworkRuntime = (
  url: string,
  onConnection: (connected: boolean) => void,
): Runtime => {
  const runtime = ManagedRuntime.make(makeNetworkLayer(url, onConnection));
  const execute: ExecuteRendererEffect = (effect, signal) =>
    runtime.runPromise(effect, signal ? { signal } : undefined);
  return {
    execute,
    observe: (source, consume, options) => observeStream(execute, source, consume, options),
    dispose: () => runtime.dispose(),
  };
};

/** One window runtime, two protocols: typed domain groups use the server; native groups stay here. */
export const makeRemoteRuntime = (
  transport: ElectronRpcTransport,
  url: string,
  onConnection: (connected: boolean) => void,
): Runtime => {
  const layer = Layer.effect(
    CakeIpcClient,
    Effect.gen(function* () {
      const local = Context.get(
        yield* Layer.build(Layer.fresh(makeRendererLayer(transport))),
        CakeIpcClient,
      );
      const remote = Context.get(
        yield* Layer.build(
          Layer.fresh(
            makeNetworkLayer(url, onConnection, local.vscodeViews.close().pipe(Effect.ignore)),
          ),
        ),
        CakeIpcClient,
      );
      const ready = <A, E>(stream: Stream.Stream<A, E>) =>
        Stream.unwrap(
          remote.backendConnection.connect({ buildId: cakeBuildId }).pipe(
            Effect.catchTag("BackendConnectionError", (error) =>
              Effect.fail(
                new RpcClientError.RpcClientError({
                  reason: new RpcClientError.RpcClientDefect({
                    message: error.message,
                    cause: error,
                  }),
                }),
              ),
            ),
            Effect.as(stream),
          ),
        );
      const client = CakeIpcClient.of({
        ...remote,
        dictation: local.dictation,
        vscodeViews: local.vscodeViews,
        vscode: {
          ...remote.vscode,
          acquire: (input) =>
            remote.vscode.acquire(input).pipe(
              Effect.map((lease) => {
                const base = new URL(url);
                base.protocol = base.protocol === "wss:" ? "https:" : "http:";
                return { ...lease, endpoint: new URL(lease.endpoint, base).href };
              }),
            ),
          observeState: () => ready(remote.vscode.observeState()),
        },
        electron: local.electron,
        browser: {
          ...local.browser,
          "respond-browser-native": remote.browser["respond-browser-native"],
          "acquire-browser-preview": (input) =>
            remote.browser["acquire-browser-preview"](input).pipe(
              Effect.flatMap((lease) =>
                local.browser["open-native-preview"]({
                  sessionId: input.sessionId,
                  endpoint: lease.endpoint,
                  secret: lease.secret,
                }).pipe(
                  Effect.mapError(
                    (error) =>
                      new BrowserError({ operation: "acquirePreview", message: error.message }),
                  ),
                  Effect.map(({ endpoint }) => ({ ...lease, endpoint })),
                ),
              ),
            ),
        },
        widgets: {
          ...remote.widgets,
          "capture-native-widget": local.widgets["capture-native-widget"],
        },
        desktopHost: local.desktopHost,
        windowState: local.windowState,
        filesystem: {
          ...remote.filesystem,
          "choose-attachments": local.filesystem["choose-attachments"],
          "read-selected-file": local.filesystem["read-selected-file"],
        },
        application: {
          ...remote.application,
          observeState: () => ready(remote.application.observeState()),
          observeAgentAvailability: () => ready(remote.application.observeAgentAvailability()),
        },
        projects: { observeCatalog: () => ready(remote.projects.observeCatalog()) },
        savedDrafts: {
          ...remote.savedDrafts,
          observe: () => ready(remote.savedDrafts.observe()),
        },
        projectSessions: {
          ...remote.projectSessions,
          observeCatalog: (input) => ready(remote.projectSessions.observeCatalog(input)),
        },
        cakeChats: {
          ...remote.cakeChats,
          observeCatalog: (input) => ready(remote.cakeChats.observeCatalog(input)),
          observeControls: (input) => ready(remote.cakeChats.observeControls(input)),
        },
        conversations: { observe: (input) => ready(remote.conversations.observe(input)) },
        discussionSessions: {
          ...remote.discussionSessions,
          observeCatalog: (input) => ready(remote.discussionSessions.observeCatalog(input)),
          observe: (input) => ready(remote.discussionSessions.observe(input)),
        },
        subagents: {
          ...remote.subagents,
          observe: (input) => ready(remote.subagents.observe(input)),
        },
        scheduledMessages: {
          ...remote.scheduledMessages,
          observe: (input) => ready(remote.scheduledMessages.observe(input)),
        },
        managedWorktrees: {
          ...remote.managedWorktrees,
          observeCatalog: () => ready(remote.managedWorktrees.observeCatalog()),
          observeOperations: () => ready(remote.managedWorktrees.observeOperations()),
        },
        events: {
          application: () =>
            Stream.merge(
              local.events.application(),
              ready(remote.events.application()).pipe(Stream.retry(Schedule.spaced("1 second"))),
            ),
          artifacts: () => ready(remote.events.artifacts()),
          terminals: () =>
            Stream.merge(
              local.events.terminals(),
              ready(remote.events.terminals()).pipe(Stream.retry(Schedule.spaced("1 second"))),
            ),
          surfaces: local.events.surfaces,
          vscode: () =>
            Stream.merge(local.vscodeViews.observeEvents(), ready(remote.events.vscode())),
        },
      });
      return yield* withEditorPresentation(client);
    }),
  );
  const runtime = ManagedRuntime.make(layer);
  const execute: ExecuteRendererEffect = (effect, signal) =>
    runtime.runPromise(effect, signal ? { signal } : undefined);
  return {
    execute,
    observe: (source, consume, options) => observeStream(execute, source, consume, options),
    dispose: () => runtime.dispose(),
  };
};
