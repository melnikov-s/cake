import { Effect, Schedule, Stream } from "effect";
import { CakeIpcClient, type CakeIpcClientService } from "../../ipc/client/CakeIpcClient";

const retrySchedule = Schedule.min([
  Schedule.exponential("250 millis"),
  Schedule.spaced("30 seconds"),
]);

export type StreamFailureAction = "retry" | "stop";

export interface StreamOptions {
  readonly classifyFailure?: (error: unknown) => StreamFailureAction;
  readonly reportFailure: (error: unknown) => void;
}

export type ExecuteRendererEffect = <Success, Failure>(
  effect: Effect.Effect<Success, Failure, CakeIpcClient>,
  signal?: AbortSignal,
) => Promise<Success>;

/** Runs one independently cancellable, retrying renderer RPC Stream. */
export const observeStream = <Value>(
  execute: ExecuteRendererEffect,
  source: (client: CakeIpcClientService) => Stream.Stream<Value, unknown>,
  consume: (value: Value) => void,
  options: StreamOptions,
) => {
  const controller = new AbortController();
  let failureReported = false;
  const reportOnce = (error: unknown) => {
    if (failureReported) return;
    failureReported = true;
    options.reportFailure(error);
  };
  const schedule = retrySchedule.pipe(
    Schedule.setInputType<unknown>(),
    Schedule.while(({ input }) => (options.classifyFailure?.(input) ?? "retry") === "retry"),
  );
  const run = Effect.flatMap(CakeIpcClient, (client) =>
    source(client).pipe(
      Stream.runForEach((value) =>
        Effect.sync(() => {
          failureReported = false;
          consume(value);
        }),
      ),
    ),
  ).pipe(
    Effect.tapError((error) => Effect.sync(() => reportOnce(error))),
    Effect.retry(schedule),
  );

  void execute(run, controller.signal).catch((error: unknown) => {
    if (!controller.signal.aborted) reportOnce(error);
  });
  return () => controller.abort();
};
