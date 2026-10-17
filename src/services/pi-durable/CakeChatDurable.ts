import { Context, Deferred, Effect, Layer } from "effect";
import type { CakeSessionRuntimeSetup } from "../pi/CakeSessionRuntimes";
import type {
  PiSessionPreview,
  PiSessionSummary,
} from "../../contracts/conversations/session-contract";
import type { CakeSessionRuntime } from "../pi/runtime/cake-session-runtime";
import type { DurableCakeChatRuntime } from "./durable-chat-runtime";
import { DurableChatError } from "./durable-chat-data";
import {
  CAKE_CHAT_SESSION_ID,
  cakeChatSideChatParentId,
} from "../../contracts/cake-chats/cake-chat-identity";
import type { RequestInspection } from "./request-inspection";
import { readDurableChatPreview, readDurableChatSummary } from "./durable-chat-catalog";
import { createRequestInspectionHistory } from "./request-inspection";
import type {
  RequestInspectionHistory,
  RequestInspectionPayload,
} from "../../contracts/conversations/request-inspection";

/** SDK construction and disk-reader boundary. CakeSessionRuntimes owns scoped leases. */
export class CakeChatDurable extends Context.Service<
  CakeChatDurable,
  {
    readonly requestHistory: (sessionId?: string) => Effect.Effect<RequestInspectionHistory>;
    readonly requestPayload: (
      id: string,
      sessionId?: string,
    ) => Effect.Effect<RequestInspectionPayload, DurableChatError>;
    readonly clearRequestHistory: (sessionId?: string) => Effect.Effect<void>;
    readonly createRuntime: (
      options: CakeSessionRuntimeSetup,
    ) => Effect.Effect<CakeSessionRuntime, DurableChatError>;
    readonly createSideChatRuntime: (
      options: CakeSessionRuntimeSetup,
    ) => Effect.Effect<CakeSessionRuntime, DurableChatError>;
    readonly inspectSideChat: (
      sessionId: string,
    ) => Effect.Effect<PiSessionPreview | undefined, DurableChatError>;
    readonly catalogEntry: (
      directory: string,
      sessionId?: string,
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

export const makeCakeChatDurableLive = (
  createRuntime: (
    options: CakeSessionRuntimeSetup,
    inspection: RequestInspection,
  ) => Promise<DurableCakeChatRuntime>,
) =>
  Layer.sync(CakeChatDurable, () => {
    // References only: RcMap owns the runtimes. Forks must reuse their own parent's Harness.
    const live = new Map<string, DurableCakeChatRuntime>();
    const ready = new Map<string, Deferred.Deferred<DurableCakeChatRuntime>>();
    const inspections = new Map<string, RequestInspection>();
    const inspection = (sessionId = CAKE_CHAT_SESSION_ID) => {
      let history = inspections.get(sessionId);
      if (!history) {
        history = createRequestInspectionHistory();
        inspections.set(sessionId, history);
      }
      return history;
    };
    const readiness = Effect.fn("CakeChatDurable.readiness")(function* (sessionId: string) {
      let deferred = ready.get(sessionId);
      if (!deferred) {
        deferred = yield* Deferred.make<DurableCakeChatRuntime>();
        ready.set(sessionId, deferred);
      }
      return deferred;
    });
    return CakeChatDurable.of({
      requestHistory: Effect.fn("CakeChatDurable.requestHistory")((sessionId) =>
        Effect.sync(() => inspection(sessionId).list()),
      ),
      requestPayload: (id, sessionId) =>
        operation("requestPayload", async () => {
          const payload = inspection(sessionId).get(id);
          if (!payload) throw new Error("Request was cleared or evicted from local history");
          return payload;
        }),
      clearRequestHistory: Effect.fn("CakeChatDurable.clearRequestHistory")((sessionId) =>
        Effect.sync(() => inspection(sessionId).clear()),
      ),
      createRuntime: Effect.fn("CakeChatDurable.createRuntime")(function* (options) {
        const sessionId = options.sessionId ?? CAKE_CHAT_SESSION_ID;
        const runtime = yield* operation("createRuntime", () =>
          createRuntime(options, inspection(sessionId)),
        );
        live.set(sessionId, runtime);
        yield* Deferred.succeed(yield* readiness(sessionId), runtime);
        const dispose = runtime.dispose.bind(runtime);
        return Object.assign(runtime, {
          async dispose() {
            if (live.get(sessionId) === runtime) {
              live.delete(sessionId);
              ready.delete(sessionId);
            }
            await dispose();
          },
        });
      }),
      createSideChatRuntime: Effect.fn("CakeChatDurable.createSideChatRuntime")(
        function* (options) {
          const parent = cakeChatSideChatParentId(options.sessionId);
          if (!parent)
            return yield* new DurableChatError({
              operation: "createSideChatRuntime",
              message: "Invalid Cake Chat side-chat address",
            });
          const runtime =
            live.get(parent) ??
            (yield* Deferred.await(yield* readiness(parent)).pipe(
              Effect.timeout("30 seconds"),
              Effect.mapError(
                () =>
                  new DurableChatError({
                    operation: "createSideChatRuntime",
                    message: "Open the parent chat to continue its side chats",
                  }),
              ),
            ));
          return yield* operation("createSideChatRuntime", () => runtime.sideChats.open(options));
        },
      ),
      inspectSideChat: (sessionId) =>
        operation("inspectSideChat", async () => {
          const parent = cakeChatSideChatParentId(sessionId);
          return parent ? live.get(parent)?.sideChats.preview(sessionId) : undefined;
        }),
      catalogEntry: (directory, sessionId = CAKE_CHAT_SESSION_ID) =>
        operation("catalogEntry", () => readDurableChatSummary(directory, sessionId)),
      inspect: (directory, sessionId) =>
        operation("inspect", async () => {
          const preview = await readDurableChatPreview(directory, sessionId);
          if (!preview) throw new Error("This chat has not started yet");
          return preview;
        }),
    });
  });
