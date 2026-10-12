import { Context, Effect, Layer } from "effect";
import type {
  PiSessionPreview,
  PiSessionSummary,
} from "../../contracts/conversations/session-contract";
import type {
  CakeSessionRuntime,
  CakeSessionRuntimeOptions,
} from "../pi/runtime/cake-session-runtime";
import { DurableChatError } from "./durable-chat-data";
import { createDurableCakeChatRuntime } from "./durable-chat-runtime";
import { readDurableChatPreview, readDurableChatSummary } from "./durable-chat-catalog";
import { createRequestInspectionHistory } from "./request-inspection";
import type {
  RequestInspectionHistory,
  RequestInspectionPayload,
} from "../../contracts/conversations/request-inspection";

/** Production coordinator adapter. CakeSessionRuntimes owns its shared scoped lease;
 * this Service owns SDK construction and disk-reader boundaries, not another agent loop. */
export class CakeChatDurable extends Context.Service<
  CakeChatDurable,
  {
    readonly requestHistory: () => Effect.Effect<RequestInspectionHistory>;
    readonly requestPayload: (
      id: string,
    ) => Effect.Effect<RequestInspectionPayload, DurableChatError>;
    readonly clearRequestHistory: () => Effect.Effect<void>;
    readonly createRuntime: (
      options: CakeSessionRuntimeOptions,
    ) => Effect.Effect<CakeSessionRuntime, DurableChatError>;
    readonly catalogEntry: (
      directory: string,
    ) => Effect.Effect<PiSessionSummary | undefined, DurableChatError>;
    readonly inspect: (
      directory: string,
      sessionId: string,
    ) => Effect.Effect<PiSessionPreview, DurableChatError>;
  }
>()("cake/services/pi-durable/CakeChatDurable") {}

const operation = <A>(name: string, evaluate: () => Promise<A>) =>
  Effect.tryPromise({
    try: evaluate,
    catch: (error) =>
      new DurableChatError({
        operation: name,
        message: error instanceof Error ? error.message : String(error),
      }),
  });

export const makeCakeChatDurableLive = () =>
  Layer.sync(CakeChatDurable, () => {
    const inspection = createRequestInspectionHistory();
    return CakeChatDurable.of({
      requestHistory: Effect.fn("CakeChatDurable.requestHistory")(() =>
        Effect.sync(inspection.list),
      ),
      requestPayload: (id) =>
        operation("requestPayload", async () => {
          const payload = inspection.get(id);
          if (!payload) throw new Error("Request was cleared or evicted from local history");
          return payload;
        }),
      clearRequestHistory: Effect.fn("CakeChatDurable.clearRequestHistory")(() =>
        Effect.sync(inspection.clear),
      ),
      createRuntime: (options) =>
        operation("createRuntime", () => createDurableCakeChatRuntime(options, inspection)),
      catalogEntry: (directory) =>
        operation("catalogEntry", () => readDurableChatSummary(directory)),
      inspect: (directory, sessionId) =>
        operation("inspect", async () => {
          const preview = await readDurableChatPreview(directory);
          if (!preview || preview.sessionId !== sessionId)
            throw new Error("Cake Chat has not started yet");
          return preview;
        }),
    });
  });
