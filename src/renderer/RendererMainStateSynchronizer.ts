import { Effect, Schedule, Stream } from "effect";
import { CakeIpcClient } from "../ipc/client/CakeIpcClient";
import type { RendererRuntime } from "./RendererRuntime";
import type { RootStore } from "./stores/RootStore";

/** Window-owned consumer for current-first main-process state projections. */
export class RendererMainStateSynchronizer implements Disposable {
  private readonly abort = new AbortController();
  private observing = false;
  private applicationRevision = -1;

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
          consume(client.application.observeState(), (projection) =>
            this.applyApplicationState(root, projection),
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
    projection: {
      readonly revision: number;
      readonly state: Parameters<RootStore["settingsStore"]["applyApplicationState"]>[1];
    },
  ) {
    if (projection.revision <= this.applicationRevision) return;
    this.applicationRevision = projection.revision;
    root.settingsStore.applyApplicationState(projection.revision, projection.state);
  }

  [Symbol.dispose]() {
    this.abort.abort();
  }
}
