import type { CakeEvent } from "../../ipc/cake-rpc-contract";
import type { RootStore } from "../stores/RootStore";

type DrawControlRequested = Extract<CakeEvent, { readonly type: "draw-control-requested" }>;

/** Completes a validated main-to-renderer Draw request against the visible session control. */
export async function handleDrawControlRequest(root: RootStore, event: DrawControlRequested) {
  let response;
  try {
    response = await root.invokeDrawControl(event.sessionId, event.invocation, root.signal);
  } catch (error) {
    response = {
      ok: false as const,
      code: "INVALID_REQUEST" as const,
      message: error instanceof Error ? error.message : String(error),
    };
  }
  await root.client.drawControl.respond(
    {
      sessionId: event.sessionId,
      drawRequestId: event.drawRequestId,
      response,
    },
    { signal: root.signal },
  );
}
