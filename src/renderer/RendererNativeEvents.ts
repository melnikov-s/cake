import { Effect, Stream } from "effect";
import { CakeIpcClient, type CakeIpcClientService } from "../ipc/client/CakeIpcClient";
import type { CakeEvent } from "../ipc/cake-rpc-contract";
import { toRendererEvent, type RendererEvent } from "./RendererEvent";
import type { RendererRuntime } from "./RendererRuntime";
import type { RendererModelSynchronizer } from "./RendererModelSynchronizer";
import type { RootStore } from "./stores/RootStore";
import type { RendererSynchronizationSupervisor } from "./RendererSynchronizationSupervisor";

const nativeEventChannels = [
  "application",
  "artifacts",
  "terminals",
  "vscode",
  "surfaces",
] as const;

/** Window-owned bridge from focused native RPC Streams to their renderer owners. */
export class RendererNativeEvents implements Disposable {
  private readonly listeners = new Set<(event: RendererEvent) => void>();
  private readonly readyChannels = new Set<(typeof nativeEventChannels)[number]>();
  private resolveReady: (() => void) | undefined;
  private readonly ready = new Promise<void>((resolve) => {
    this.resolveReady = resolve;
  });
  private disposed = false;
  private started = false;

  constructor(
    private readonly runtime: RendererRuntime,
    private readonly supervisor: RendererSynchronizationSupervisor,
  ) {}

  private start() {
    if (this.started || this.disposed) return;
    this.started = true;
    const register = <Event extends CakeEvent>(
      channel: (typeof nativeEventChannels)[number],
      events: (client: CakeIpcClientService) => Stream.Stream<Event, unknown>,
    ) =>
      this.supervisor.register(`native:${channel}`, {
        run: (signal, markHealthy) =>
          this.runtime.runPromise(
            Effect.flatMap(CakeIpcClient, (client) =>
              events(client).pipe(
                Stream.runForEach((event) =>
                  Effect.sync(() => {
                    markHealthy();
                    this.receive(event);
                  }),
                ),
              ),
            ),
            { signal },
          ),
        reportFailure: (error) => {
          this.completeReadyChannel(channel);
          console.error(`[cake.renderer] native ${channel} synchronization failed`, error);
        },
      });
    register("application", (client) => client.events.application());
    register("artifacts", (client) => client.events.artifacts());
    register("terminals", (client) => client.events.terminals());
    register("vscode", (client) => client.events.vscode());
    register("surfaces", (client) => client.events.surfaces());
  }

  private receive(event: CakeEvent) {
    if (event.type === "renderer-events-ready") {
      this.completeReadyChannel(event.channel);
      return;
    }
    const rendererEvent = toRendererEvent(event);
    if (rendererEvent) for (const listener of this.listeners) listener(rendererEvent);
  }

  private completeReadyChannel(channel: (typeof nativeEventChannels)[number]) {
    this.readyChannels.add(channel);
    if (this.readyChannels.size !== nativeEventChannels.length) return;
    this.resolveReady?.();
    this.resolveReady = undefined;
  }

  subscribe(listener: (event: RendererEvent) => void) {
    if (this.disposed) return () => undefined;
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Routes non-authoritative native lifecycle events outside the Store tree. */
  observe(root: RootStore, synchronizer: RendererModelSynchronizer) {
    this.subscribe((event) => {
      try {
        if (event.type === "artifact-updated") {
          synchronizer.updateArtifact(event.record);
          return;
        }
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
        if (event.type === "embedded-editor-toggle-mode-requested") {
          if (root.appShellStore.selection.kind === "project-session")
            void root.projectWorkbenchStore.toggleIde();
          return;
        }
        if (event.type === "project-session-control-requested") {
          void root.respondProjectSessionControl(event).catch((error) => {
            if (!root.signal.aborted)
              root.projectWorkbenchStore.setError(error, "Project Session control response");
          });
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
    this.start();
    return this.ready;
  }

  [Symbol.dispose]() {
    if (this.disposed) return;
    this.disposed = true;
    this.resolveReady?.();
    this.resolveReady = undefined;
    for (const channel of nativeEventChannels) this.supervisor.unregister(`native:${channel}`);
    this.listeners.clear();
  }
}
