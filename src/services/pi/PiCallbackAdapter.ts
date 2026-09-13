import { Effect, type Context } from "effect";

/**
 * Executes Cake Effects only when adapting them to Promise callbacks required by Pi.
 * Keep every caller at the final Pi runtime-options boundary.
 */
export const makePiCallbackExecutor = <R>(context: Context.Context<R>) => {
  const run = Effect.runPromiseWith(context);
  return <A, E>(
    effect: Effect.Effect<A, E, R>,
    options?: AbortSignal | { readonly signal?: AbortSignal },
  ) => {
    const signal = options instanceof AbortSignal ? options : options?.signal;
    return run(effect, signal ? { signal } : undefined);
  };
};
