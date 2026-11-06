import type { WebContents } from "electron";

/** Electron's Promise APIs do not accept AbortSignal. Own the wait and its native
 * cancellation together, including disconnects; do not leave timers/listeners behind. */
export function browserNativeOperation<A>(options: {
  readonly contents: WebContents;
  readonly operation: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  readonly cdp?: boolean;
  readonly start: () => Promise<A>;
  readonly cancel: () => void;
}): Promise<A> {
  const { contents, operation, timeoutMs, signal } = options;
  signal?.throwIfAborted();
  const started = performance.now();
  return new Promise<A>((resolve, reject) => {
    let settled = false;
    const elapsed = () => Math.round(performance.now() - started);
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", aborted);
      contents.removeListener("destroyed", disconnected);
      contents.removeListener("render-process-gone", disconnected);
      if (options.cdp) contents.debugger.removeListener("detach", disconnected);
    };
    const finish = (result: { value: A } | { error: unknown }, cancel = false) => {
      if (settled) return;
      settled = true;
      cleanup();
      if ("error" in result) reject(result.error);
      else resolve(result.value);
      if (cancel) {
        // Settle/remove our listeners first: detach can synchronously notify other commands.
        // The view/process may already be gone. Cleanup failure must not hide the original error.
        try {
          options.cancel();
        } catch {
          // No further safe native cancellation is available; never close a user's page.
        }
      }
    };
    const disconnected = () =>
      finish({
        error: new Error(`${operation} disconnected after ${elapsed()}ms; outcome unknown`),
      });
    const aborted = () => {
      const error = new Error(`${operation} aborted after ${elapsed()}ms; outcome unknown`);
      error.name = "AbortError";
      finish({ error }, true);
    };
    const timer = setTimeout(() => {
      const error = new Error(
        `${operation} timed out after ${elapsed()}ms (deadline ${timeoutMs}ms); outcome unknown, do not automatically retry`,
      );
      error.name = "TimeoutError";
      finish({ error }, true);
    }, timeoutMs);
    contents.on("destroyed", disconnected);
    contents.on("render-process-gone", disconnected);
    if (options.cdp) contents.debugger.on("detach", disconnected);
    signal?.addEventListener("abort", aborted, { once: true });
    try {
      options.start().then(
        (value) => finish({ value }),
        (error) => finish({ error }),
      );
    } catch (error) {
      finish({ error });
    }
  });
}
