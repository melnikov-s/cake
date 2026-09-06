import { Effect, Stream } from "effect";
import { CakeIpcClient, type CakeIpcClientService } from "../ipc/client/CakeIpcClient";
import type { RendererRuntime } from "./RendererRuntime";
import type { RootStore } from "./stores/RootStore";
import type { RendererSynchronizationSupervisor } from "./RendererSynchronizationSupervisor";

/** Window-owned consumer for current-first main-process state projections. */
export class RendererMainStateSynchronizer implements Disposable {
  private observing = false;
  private applicationRevision = -1;

  constructor(
    private readonly runtime: RendererRuntime,
    private readonly supervisor: RendererSynchronizationSupervisor,
  ) {}

  observe(root: RootStore) {
    if (this.observing) return;
    this.observing = true;
    const register = <A>(
      key: string,
      stream: (client: CakeIpcClientService) => Stream.Stream<A, unknown>,
      apply: (value: A) => void,
    ) =>
      this.supervisor.register(`state:${key}`, {
        run: (signal, markHealthy) =>
          this.runtime.execute(
            Effect.flatMap(CakeIpcClient, (client) =>
              stream(client).pipe(
                Stream.runForEach((value) =>
                  Effect.sync(() => {
                    markHealthy();
                    apply(value);
                  }),
                ),
              ),
            ),
            signal,
          ),
        reportFailure: (error) =>
          root.projectWorkbenchStore.setError(error, `Main-process ${key} synchronization`),
      });
    register(
      "application",
      (client) => client.application.observeState(),
      (projection) => this.applyApplicationState(root, projection),
    );
    register(
      "agent-availability",
      (client) => client.application.observeAgentAvailability(),
      (snapshot) => root.projectWorkbenchStore.applyAgentAvailability(snapshot),
    );
    register(
      "vscode",
      (client) => client.vscode.observeState(),
      (state) => root.projectWorkbenchStore.embeddedEditorStore.applyState(state),
    );
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
    for (const key of ["application", "agent-availability", "vscode"])
      this.supervisor.unregister(`state:${key}`);
  }
}
