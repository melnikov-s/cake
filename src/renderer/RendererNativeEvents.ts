import { Effect, Schedule, Stream } from "effect";
import { CakeIpcClient } from "../ipc/client/CakeIpcClient";
import type { CakeEvent } from "../ipc/cake-rpc-contract";
import { toRendererEvent, type RendererEvent } from "./RendererEvent";
import type { RendererRuntime } from "./RendererRuntime";
import type { RendererModelSynchronizer } from "./RendererModelSynchronizer";
import type { RootStore } from "./stores/RootStore";

const nativeEventChannels = [
  "application",
  "artifacts",
  "plugins",
  "terminals",
  "vscode",
  "surfaces",
] as const;

/** Window-owned bridge from focused native RPC Streams to their renderer owners. */
export class RendererNativeEvents implements Disposable {
  private readonly abort = new AbortController();
  private readonly listeners = new Set<(event: RendererEvent) => void>();
  private readonly readyChannels = new Set<(typeof nativeEventChannels)[number]>();
  private resolveReady: (() => void) | undefined;
  private readonly ready = new Promise<void>((resolve) => {
    this.resolveReady = resolve;
  });
  private disposed = false;
  private started = false;

  constructor(private readonly runtime: RendererRuntime) {}

  private start() {
    if (this.started || this.disposed) return;
    this.started = true;
    const consume = <Event extends CakeEvent>(events: Stream.Stream<Event, unknown>) =>
      events.pipe(
        Stream.retry(Schedule.spaced("250 millis")),
        Stream.runForEach((event) =>
          Effect.sync(() => {
            if (event.type === "renderer-events-ready") {
              this.readyChannels.add(event.channel);
              if (this.readyChannels.size === nativeEventChannels.length) {
                this.resolveReady?.();
                this.resolveReady = undefined;
              }
              return;
            }
            const rendererEvent = toRendererEvent(event);
            if (rendererEvent) for (const listener of this.listeners) listener(rendererEvent);
          }),
        ),
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
    void this.runtime.runPromise(program, { signal: this.abort.signal }).catch((error) => {
      if (!this.abort.signal.aborted)
        console.error("[cake.renderer] native event synchronization failed", error);
    });
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
    this.abort.abort();
    this.listeners.clear();
  }
}
