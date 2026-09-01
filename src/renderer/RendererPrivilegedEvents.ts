import { Effect, Option, Schema, Stream } from "effect";
import { CakeIpcClient } from "../ipc/client/CakeIpcClient";
import { privilegedEventSchema } from "../ipc/privileged-contract";
import { toRendererEvent, type RendererEvent } from "./RendererEvent";
import type { RendererRuntime } from "./RendererRuntime";
import type { RootStore } from "./stores/RootStore";
import type { RendererModelSynchronizer } from "./RendererModelSynchronizer";

const privilegedReadySchema = Schema.Struct({ type: Schema.Literal("privileged-stream-ready") });

/** Window-owned bridge from the privileged RPC event Stream to legacy event consumers. */
export class RendererPrivilegedEvents implements Disposable {
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
    const consume = Effect.flatMap(CakeIpcClient, (client) =>
      client.privileged.observe().pipe(
        Stream.runForEach((input) =>
          Effect.sync(() => {
            if (Option.isSome(Schema.decodeUnknownOption(privilegedReadySchema)(input))) {
              resolveReady();
              return;
            }
            const event = toRendererEvent(Schema.decodeUnknownSync(privilegedEventSchema)(input));
            if (event) for (const listener of this.listeners) listener(event);
          }),
        ),
      ),
    );
    void runtime.runPromise(consume, { signal: this.abort.signal }).catch(rejectReady);
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
