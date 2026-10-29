import { Effect, Queue, Stream } from "effect";
import type { artifactEventSchema } from "../../../src/contracts/application/cake-rpc-contract";
import { observeArtifactEvents } from "../../../src/renderer/observers/artifact-events";
import type { RootStore } from "../../../src/renderer/stores/RootStore";
import { observerClient, observerRuntime } from "./observers/observer-test-runtime";

/** External artifact stream with a consumption barrier; routing and all Stores stay real. */
export function artifactObserverWorkflowEvents(root: RootStore) {
  const events = Effect.runSync(Queue.unbounded<typeof artifactEventSchema.Type>());
  const runtime = observerRuntime(
    observerClient({ events: { artifacts: () => Stream.fromQueue(events) } }),
  );
  const stop = observeArtifactEvents(runtime, root);
  return {
    async emit(event: typeof artifactEventSchema.Type) {
      Queue.offerUnsafe(events, event);
      await Effect.runPromise(Queue.take(runtime.consumed));
    },
    async [Symbol.asyncDispose]() {
      stop();
      await runtime.dispose();
    },
  };
}
