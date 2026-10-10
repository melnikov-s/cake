import { Context, Effect, Layer } from "effect";
import type { PiSessionPreview, PiSessionSummary } from "../../ipc/session-contract";
import type {
  CakeSessionRuntime,
  CakeSessionRuntimeOptions,
} from "../pi/runtime/cake-session-runtime";
import { DurableChatError } from "./durable-chat-data";
import { createDurableCakeChatRuntime } from "./durable-chat-runtime";
import { readDurableChatPreview, readDurableChatSummary } from "./durable-chat-catalog";

/** Production coordinator adapter. CakeSessionRuntimes owns its shared scoped lease;
 * this Service owns SDK construction and disk-reader boundaries, not another agent loop. */
export class CakeChatDurable extends Context.Service<
  CakeChatDurable,
  {
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
  Layer.succeed(CakeChatDurable, {
    createRuntime: (options) =>
      operation("createRuntime", () => createDurableCakeChatRuntime(options)),
    catalogEntry: (directory) => operation("catalogEntry", () => readDurableChatSummary(directory)),
    inspect: (directory, sessionId) =>
      operation("inspect", async () => {
        const preview = await readDurableChatPreview(directory);
        if (!preview || preview.sessionId !== sessionId)
          throw new Error("Cake Chat has not started yet");
        return preview;
      }),
  });
