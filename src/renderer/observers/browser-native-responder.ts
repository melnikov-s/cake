import { Effect } from "effect";
import type { CakeEvent } from "../../contracts/application/cake-rpc-contract";
import { CakeIpcClient } from "../../ipc/client/CakeIpcClient";

/** One correlated response; connection/session authorization and deadlines remain backend-owned. */
export const respondBrowserNative = Effect.fn("Renderer.respondBrowserNative")(function* (
  event: Extract<CakeEvent, { type: "browser-native-requested" }>,
  host: "desktop" | "browser",
) {
  const client = yield* CakeIpcClient;
  const result = yield* Effect.gen(function* () {
    if (host === "browser")
      return yield* Effect.fail(new Error("Native Browser Mode is unavailable in this browser"));
    if (event.operation === "enter") {
      yield* client.browser["native-browser-enter"]({
        sessionId: event.sessionId,
        workspacePath: event.workspacePath,
        ...(event.startupUrl ? { startupUrl: event.startupUrl } : undefined),
      });
      return { status: "completed" as const, value: null };
    }
    if (event.operation === "cdp") {
      if (!event.method || !event.params)
        return yield* Effect.fail(new Error("Incomplete CDP request"));
      return yield* client.browser["native-browser-cdp"]({
        sessionId: event.sessionId,
        method: event.method,
        params: event.params,
      });
    }
    return yield* client.browser["native-browser-events"]({
      sessionId: event.sessionId,
      methods: event.methods ?? [],
      limit: event.limit ?? 100,
      clear: event.clear ?? true,
    });
  }).pipe(
    Effect.catch((cause) =>
      Effect.succeed({
        status: "failed" as const,
        message: (cause instanceof Error ? cause.message : String(cause)).slice(0, 2_000),
      }),
    ),
  );
  yield* client.browser["respond-browser-native"]({
    requestId: event.requestId,
    sessionId: event.sessionId,
    result,
  });
});
