import type { Effect } from "effect";
import type { CakeIpcClient } from "../../ipc/client/CakeIpcClient";
import type { Runtime } from "../runtime";

/** Owned by the single application event intake, including across stream reconnects.
 * IDs are receipts, not a retry/cache registry: never replay a native mutation.
 * Aborting interrupts renderer work/replies; it does not promise end-to-end native cancellation.
 * Backend ownership checks and pending-request timeouts still reject stale replies.
 */
export const createNativeRequestDispatch = (
  runtime: Runtime,
  reportFailure: (error: unknown, context: string) => void,
) => {
  const controller = new AbortController();
  const accepted = new Set<string>();
  return {
    dispatch(
      requestId: string,
      response: Effect.Effect<void, unknown, CakeIpcClient>,
      context: string,
    ) {
      if (controller.signal.aborted || accepted.has(requestId)) return;
      accepted.add(requestId);
      void runtime.execute(response, controller.signal).catch((error: unknown) => {
        if (!controller.signal.aborted) reportFailure(error, context);
      });
    },
    dispose() {
      controller.abort();
      accepted.clear();
    },
  };
};
