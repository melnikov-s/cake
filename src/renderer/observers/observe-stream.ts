import { Effect, Schedule, Stream } from "effect";
import { CakeIpcClient, type CakeIpcClientService } from "../../ipc/client/CakeIpcClient";

const retrySchedule = Schedule.min([
  Schedule.exponential("250 millis"),
  Schedule.spaced("1 second"),
]);

export type StreamFailureAction = "retry" | "stop";

export interface StreamOptions {
  readonly classifyFailure?: (error: unknown) => StreamFailureAction;
  readonly onStopped?: (error: unknown) => void;
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
  const attempt = Effect.suspend(() => {
    let receivedValue = false;
    return Effect.flatMap(CakeIpcClient, (client) =>
      source(client).pipe(
        Stream.runForEach((value) =>
          Effect.sync(() => {
            receivedValue = true;
            consume(value);
            failureReported = false;
          }),
        ),
      ),
    ).pipe(
      Effect.catch((error) =>
        Effect.sync(() => reportOnce(error)).pipe(
          Effect.andThen(
            (options.classifyFailure?.(error) ?? "retry") === "stop" || !receivedValue
              ? Effect.fail(error)
              : Effect.void,
          ),
        ),
      ),
    );
  });
  const run = attempt.pipe(
    Effect.retry(schedule),
    Effect.andThen(Effect.sleep("250 millis")),
    Effect.repeat(Schedule.forever),
    Effect.asVoid,
  );

  void execute(run, controller.signal).catch((error: unknown) => {
    if (!controller.signal.aborted) {
      reportOnce(error);
      options.onStopped?.(error);
    }
  });
  return () => controller.abort();
};
