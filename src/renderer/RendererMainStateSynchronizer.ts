import { Effect, Schedule, Stream } from "effect";
import { CakeIpcClient } from "../ipc/client/CakeIpcClient";
import type { RendererRuntime } from "./RendererRuntime";
import type { RootStore } from "./stores/RootStore";

/** Window-owned consumer for current-first main-process state projections. */
export class RendererMainStateSynchronizer implements Disposable {
  private readonly abort = new AbortController();
  private observing = false;

  constructor(private readonly runtime: RendererRuntime) {}

  observe(root: RootStore) {
    if (this.observing) return;
    this.observing = true;
    const consume = <A>(stream: Stream.Stream<A, unknown>, apply: (value: A) => void) =>
      stream.pipe(
        Stream.retry(Schedule.spaced("250 millis")),
        Stream.runForEach((value) => Effect.sync(() => apply(value))),
      );
    const program = Effect.flatMap(CakeIpcClient, (client) =>
      Effect.all(
        [
          consume(client.application.observeState(), ({ state }) =>
            this.applyApplicationState(root, state),
          ),
          consume(client.application.observeAgentAvailability(), (snapshot) =>
            root.projectWorkbenchStore.applyAgentAvailability(snapshot),
          ),
          consume(client.plugins.observeCustomization(), (state) =>
            root.customizationStore.applyState(state),
          ),
          consume(client.vscode.observeState(), (state) =>
            root.projectWorkbenchStore.embeddedEditorStore.applyState(state),
          ),
        ],
        { concurrency: "unbounded", discard: true },
      ),
    );
    void this.runtime.runPromise(program, { signal: this.abort.signal }).catch((error) => {
      if (!this.abort.signal.aborted)
        root.projectWorkbenchStore.setError(error, "Main-process state synchronization");
    });
  }

  private applyApplicationState(
    root: RootStore,
    state: Parameters<RootStore["settingsStore"]["applyApplicationState"]>[0],
  ) {
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
    root.settingsStore.applyApplicationState(state);
    root.terminalStore.discardResolvedSessions([
      ...state.resolvedSessionIds.map((sessionId) => ({ kind: "project" as const, sessionId })),
      ...state.resolvedCakeChatSessionIds.map((sessionId) => ({
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
  }

  [Symbol.dispose]() {
    this.abort.abort();
  }
}
