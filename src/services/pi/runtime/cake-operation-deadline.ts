/** Caller wait budget, not a lifetime limit for work launched into a background owner. */
export const CAKE_OPERATION_DEADLINE_MS = 5 * 60 * 1_000;

/**
 * Bound the Promise boundary as well as cooperative cancellation. In particular, do not
 * await handler cleanup: a handler/finalizer that ignores abort must not pin its caller.
 * A timeout says nothing about whether a mutation committed; never retry it here.
 */
export function withCakeOperationDeadline<A>(
  command: string,
  callerSignal: AbortSignal,
  execute: (signal: AbortSignal) => Promise<A>,
): Promise<A> {
  if (callerSignal.aborted) return Promise.reject(callerSignal.reason);
  return new Promise<A>((resolve, reject) => {
    const controller = new AbortController();
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      callerSignal.removeEventListener("abort", onAbort);
    };
    const succeed = (value: A) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const cancel = (reason: unknown) => {
      // Settle first so even a synchronous abort listener cannot replace the outcome.
      fail(reason);
      controller.abort(reason);
    };
    const onAbort = () => cancel(callerSignal.reason);
    const timer = setTimeout(
      () =>
        cancel(
          new DOMException(
            `Cake command ${command} timed out after ${CAKE_OPERATION_DEADLINE_MS}ms (5 minutes). The operation may still have taken effect or may continue; rollback is not guaranteed. Inspect its state before deciding whether to retry.`,
            "TimeoutError",
          ),
        ),
      CAKE_OPERATION_DEADLINE_MS,
    );
    callerSignal.addEventListener("abort", onAbort, { once: true });
    try {
      // Both handlers remain attached after cancellation, consuming any late rejection.
      execute(controller.signal).then(succeed, fail);
    } catch (error) {
      fail(error);
    }
  });
}
