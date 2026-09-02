import { Effect } from "effect";
import { PluginRuntimeError } from "./PluginRuntime";

/** Converts one PluginHost Promise callback at the imperative host boundary. */
export const adaptPluginHostOperation = <Payload, Success>(
  name: string,
  execute: (connectionId: number, payload: Payload) => Promise<Success>,
  interrupt?: (connectionId: number, payload: Payload) => Promise<void>,
): ((connectionId: number, payload: Payload) => Effect.Effect<Success, PluginRuntimeError>) =>
  Effect.fn(name)((connectionId, payload) =>
    Effect.tryPromise({
      try: (signal) => {
        const cancel = () => {
          void interrupt?.(connectionId, payload).catch(() => undefined);
        };
        signal.addEventListener("abort", cancel, { once: true });
        return execute(connectionId, payload).finally(() =>
          signal.removeEventListener("abort", cancel),
        );
      },
      catch: (cause) =>
        new PluginRuntimeError({ message: cause instanceof Error ? cause.message : String(cause) }),
    }),
  );
