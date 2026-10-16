import { Context, Effect, Layer } from "effect";
import type { CakeSessionRuntimeSetup } from "../pi/CakeSessionRuntimes";
import type {
  PiSessionPreview,
  PiSessionSummary,
} from "../../contracts/conversations/session-contract";
import type { CakeSessionRuntime } from "../pi/runtime/cake-session-runtime";
import type { DurableCakeChatRuntime } from "./durable-chat-runtime";
import { DurableChatError } from "./durable-chat-data";
import type { RequestInspection } from "./request-inspection";
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
      options: CakeSessionRuntimeSetup,
    ) => Effect.Effect<CakeSessionRuntime, DurableChatError>;
    /** A side chat forked inside Cake Chat's database runs on the live coordinator's Harness. */
    readonly createSideChatRuntime: (
      options: CakeSessionRuntimeSetup,
    ) => Effect.Effect<CakeSessionRuntime, DurableChatError>;
    /** Side chat transcript preview; undefined while Cake Chat is not open. */
    readonly inspectSideChat: (
      sessionId: string,
    ) => Effect.Effect<PiSessionPreview | undefined, DurableChatError>;
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

/** How long a side chat waits for the coordinator a concurrent Cake Chat open is starting. */
const SIDE_CHAT_COORDINATOR_WAIT_MS = 30_000;

export const makeCakeChatDurableLive = (
  createRuntime: (
    options: CakeSessionRuntimeSetup,
    inspection: RequestInspection,
  ) => Promise<DurableCakeChatRuntime>,
) =>
  Layer.sync(CakeChatDurable, () => {
    const inspection = createRequestInspectionHistory();
    // Only one process and one Harness may own the coordinator database, so side-chat
    // forks reuse the live coordinator rather than opening their own.
    let live: DurableCakeChatRuntime | undefined;
    let waiters: Array<(runtime: DurableCakeChatRuntime) => void> = [];
    const coordinator = () =>
      live
        ? Promise.resolve(live)
        : new Promise<DurableCakeChatRuntime>((resolve, reject) => {
            const timer = setTimeout(() => {
              waiters = waiters.filter((waiter) => waiter !== ready);
              reject(new Error("Open Cake Chat to continue its side chats"));
            }, SIDE_CHAT_COORDINATOR_WAIT_MS);
            const ready = (runtime: DurableCakeChatRuntime) => {
              clearTimeout(timer);
              resolve(runtime);
            };
            waiters.push(ready);
          });
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
        operation("createRuntime", async () => {
          const runtime = await createRuntime(options, inspection);
          live = runtime;
          for (const ready of waiters.splice(0)) ready(runtime);
          const dispose = runtime.dispose.bind(runtime);
          return Object.assign(runtime, {
            async dispose() {
              if (live === runtime) live = undefined;
              await dispose();
            },
          });
        }),
      createSideChatRuntime: (options) =>
        operation("createSideChatRuntime", async () =>
          (await coordinator()).sideChats.open(options),
        ),
      inspectSideChat: (sessionId) =>
        operation("inspectSideChat", async () => live?.sideChats.preview(sessionId)),
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
