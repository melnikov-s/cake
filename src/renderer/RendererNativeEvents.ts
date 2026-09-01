import { Effect, Stream } from "effect";
import { CakeIpcClient } from "../ipc/client/CakeIpcClient";
import type { NativeEvent } from "../ipc/native-protocol";
import { toRendererEvent, type RendererEvent } from "./RendererEvent";
import type { RendererRuntime } from "./RendererRuntime";
import type { RendererModelSynchronizer } from "./RendererModelSynchronizer";
import type { RootStore } from "./stores/RootStore";

/** Window-owned bridge from focused native RPC Streams to their renderer owners. */
export class RendererNativeEvents implements Disposable {
  private readonly abort = new AbortController();
  private readonly listeners = new Set<(event: RendererEvent) => void>();
  private disposed = false;
  readonly ready: Promise<void>;

  constructor(runtime: RendererRuntime) {
    let resolveReady!: () => void;
    let rejectReady!: (error: unknown) => void;
    this.ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });

    let pendingStreams = 6;
    const consume = <Event extends NativeEvent | { readonly type: "native-stream-ready" }>(
      events: Stream.Stream<Event, unknown>,
    ) =>
      Stream.runForEach(events, (event) =>
        Effect.sync(() => {
          if (event.type === "native-stream-ready") {
            pendingStreams -= 1;
            if (pendingStreams === 0) resolveReady();
            return;
          }
          const rendererEvent = toRendererEvent(event);
          if (rendererEvent) for (const listener of this.listeners) listener(rendererEvent);
        }),
      );
    const program = Effect.flatMap(CakeIpcClient, (client) =>
      Effect.all(
        [
          consume(client.events.application()),
          consume(client.events.artifacts()),
          consume(client.events.plugins()),
          consume(client.events.terminals()),
          consume(client.events.vscode()),
          consume(client.events.surfaces()),
        ],
        { concurrency: "unbounded", discard: true },
      ),
    );
    void runtime.runPromise(program, { signal: this.abort.signal }).catch(rejectReady);
  }

  subscribe(listener: (event: RendererEvent) => void) {
    if (this.disposed) return () => undefined;
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Routes non-authoritative native lifecycle events outside the Store tree. */
  observe(root: RootStore, synchronizer: RendererModelSynchronizer) {
    return this.subscribe((event) => {
      try {
        if (event.type === "artifact-updated") {
          synchronizer.updateArtifact(event.record);
          return;
        }
        root.customizationStore.receive(event);
        if (event.type === "notification") {
          root.toastStore.show(event);
          return;
        }
        if (event.type === "terminal-data" || event.type === "terminal-exited") {
          root.terminalStore.receive(event);
          return;
        }
        if (event.type === "terminal-toggle-requested") {
          void root.terminalStore.toggle();
          return;
        }
        if (event.type === "application-state-changed") {
          const activeProjectSessionId =
            root.appShellStore.activeConversation?.kind === "project-session"
              ? root.appShellStore.activeConversation.sessionId
              : undefined;
          const activeProjectSessionWasResolved = activeProjectSessionId
            ? root.sessionCatalogStore.find(activeProjectSessionId)?.resolved === true
            : false;
          const activeCakeChatSessionId =
            root.appShellStore.activeConversation?.kind === "cake-chat"
              ? root.appShellStore.activeConversation.sessionId
              : undefined;
          const activeCakeChatSessionWasResolved = activeCakeChatSessionId
            ? root.globalChatStore.isSessionResolved(activeCakeChatSessionId)
            : false;
          root.settingsStore.applyApplicationState(event.state);
          root.terminalStore.discardResolvedSessions([
            ...event.state.resolvedSessionIds.map((sessionId) => ({
              kind: "project" as const,
              sessionId,
            })),
            ...event.state.resolvedCakeChatSessionIds.map((sessionId) => ({
              kind: "cake-chat" as const,
              sessionId,
            })),
          ]);
          if (
            activeProjectSessionId &&
            activeProjectSessionWasResolved &&
            !root.sessionCatalogStore.find(activeProjectSessionId)?.resolved
          )
            root.appShellStore.selectProjectSession(activeProjectSessionId);
          if (
            activeCakeChatSessionId &&
            activeCakeChatSessionWasResolved &&
            !root.globalChatStore.isSessionResolved(activeCakeChatSessionId)
          )
            root.appShellStore.selectCakeChat(activeCakeChatSessionId);
          return;
        }
        root.extensionUiStore.receive(event);
        if (event.type === "artifact-requested")
          root.sessionRegistry.findSession(event.record.artifact.sessionId)?.receive(event);
        root.projectWorkbenchStore.receive(event);
      } catch (error) {
        root.projectWorkbenchStore.setError(error, `Native event: ${event.type}`);
      }
    });
  }

  [Symbol.dispose]() {
    if (this.disposed) return;
    this.disposed = true;
    this.abort.abort();
    this.listeners.clear();
  }
}
