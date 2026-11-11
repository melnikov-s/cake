import { Effect, Layer, Queue, Stream } from "effect";
import { WidgetRunGate } from "../../../src/services/artifact-runtime/WidgetRunGate";

/** Attachment facts for runtime/schedule tests whose subject is not attachment storage. */
export function widgetRunGateFake(initial: Iterable<readonly [string, number]> = []) {
  const attached = new Map<string, number>(initial);
  const listeners = new Set<() => void>();
  const layer = Layer.succeed(
    WidgetRunGate,
    WidgetRunGate.of({
      attachedRevision: (lineageId) => Effect.sync(() => attached.get(lineageId)),
      changes: () =>
        Stream.callback<void>((queue) =>
          Effect.acquireRelease(
            Effect.sync(() => {
              const listener = () => {
                Queue.offerUnsafe(queue, undefined);
              };
              listeners.add(listener);
              return listener;
            }),
            (listener) => Effect.sync(() => listeners.delete(listener)),
          ),
        ),
    }),
  );
  /** Attach at a revision, or detach with undefined; then signal running work like a real change. */
  const set = (lineageId: string, revision: number | undefined) => {
    if (revision === undefined) attached.delete(lineageId);
    else attached.set(lineageId, revision);
    for (const listener of listeners) listener();
  };
  return { layer, set };
}
