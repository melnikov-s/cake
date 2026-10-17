import { Effect, Queue } from "effect";
import { CakeIpcClient, type CakeIpcClientService } from "../../../../src/ipc/client/CakeIpcClient";
import { observeStream } from "../../../../src/renderer/observers/observe-stream";
import type { Runtime } from "../../../../src/renderer/runtime";

export type ObserverClientOverrides = {
  readonly [Group in keyof CakeIpcClientService]?: Partial<CakeIpcClientService[Group]>;
};

/** Typed external transport fake; unconfigured operations fail rather than silently succeed. */
export function observerClient(overrides: ObserverClientOverrides): CakeIpcClientService {
  const operations = new Map<string, Map<PropertyKey, unknown>>();
  for (const [group, methods] of Object.entries(overrides)) {
    if (methods) operations.set(group, new Map(Object.entries(methods)));
  }
  // SAFETY: the Proxy implements the typed override operations below, and every
  // unconfigured operation throws; no unvalidated transport value is decoded here.
  const target = Object.create(null) as CakeIpcClientService;
  return new Proxy(target, {
    get(_target, group: keyof CakeIpcClientService) {
      const service = operations.get(group);
      return new Proxy(
        {},
        {
          get(_service, operation) {
            if (service?.has(operation)) return service.get(operation);
            return () => {
              throw new Error(
                `Unexpected observer transport call: ${String(group)}.${String(operation)}`,
              );
            };
          },
        },
      );
    },
  });
}

/** Runs the real observation primitive, with a post-consumption barrier for deterministic assertions. */
export function observerRuntime(client: CakeIpcClientService) {
  const consumed = Effect.runSync(Queue.unbounded<unknown>());
  const pending = new Set<Promise<unknown>>();
  const execute: Runtime["execute"] = (effect, signal) => {
    const result = Effect.runPromise(
      Effect.provideService(effect, CakeIpcClient, client),
      signal ? { signal } : undefined,
    );
    const finished = result.then(
      () => undefined,
      () => undefined,
    );
    pending.add(finished);
    void finished.then(() => pending.delete(finished));
    return result;
  };
  const runtime: Runtime = {
    execute,
    observe: (source, consume, options) =>
      observeStream(
        execute,
        source,
        (event) => {
          consume(event);
          Queue.offerUnsafe(consumed, event);
        },
        options,
      ),
    dispose: async () => {
      await Promise.all(pending);
    },
  };
  return { ...runtime, consumed };
}
