import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { Cause, Deferred, Effect, Exit, Queue, Schema } from "effect";
import {
  ArtifactRuntimeError,
  type ArtifactRuntimeTarget,
} from "../../../contracts/artifacts/artifact-runtime";
import type { ArtifactRuntimeHost } from "../../artifact-runtime/ArtifactRuntime";
import { ArtifactStorage } from "../../storage/ArtifactStorage";
import { ClientEvents } from "../../clients/ClientEvents";
import type { ArtifactNavigationContext } from "../../../contracts/artifacts/artifact-navigation-context";

const failure = (operation: string, cause: unknown) =>
  new ArtifactRuntimeError({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
  });
const CakeRequest = Schema.Struct({ command: Schema.String, input: Schema.Json });
const Completion = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), value: Schema.Json }),
  Schema.Struct({ ok: Schema.Literal(false), message: Schema.String }),
]);
interface Event {
  readonly kind: "tool" | "lifecycle";
  readonly name: string;
  readonly input: Schema.Json;
  readonly callingSessionId?: string;
  readonly windowConnectionId?: number;
  readonly viewId?: string;
  readonly navigation?: ArtifactNavigationContext;
}
// One execution stays alive at __artifactNext, retaining its own JS closures. No DOM or hidden
// renderer is involved. Host capabilities are JSON bridges; JS never receives Node globals.
const program = (source: string) => `
const cake = (command, input = {}) => __artifactCake({ command, input });
const data = Object.freeze({
  read: () => __artifactRead(),
  write: (value) => __artifactWrite(value),
});
const runtime = await (async () => {\n${source}\n})();
if (!runtime || typeof runtime !== "object" || !runtime.tools) throw new Error("Runtime must return { tools, lifecycle? }");
await runtime.lifecycle?.start?.({ event: "start" });
await __artifactReady();
while (true) {
  const event = await __artifactNext();
  try {
    let result;
    if (event.kind === "tool") {
      if (!Object.hasOwn(runtime.tools, event.name) || typeof runtime.tools[event.name] !== "function")
        throw new Error("Runtime handler missing: " + event.name);
      result = await runtime.tools[event.name](event.input, event);
    } else {
      result = await runtime.lifecycle?.[event.name]?.(event);
    }
    await __artifactComplete({ ok: true, value: result === undefined ? null : result });
  } catch (error) {
    await __artifactComplete({ ok: false, message: error instanceof Error ? error.message : String(error) });
  }
  if (event.kind === "lifecycle" && (event.name === "stop" || event.name === "delete")) break;
}
`;

export const makeArtifactRuntimeWorker = Effect.fn("ArtifactRuntime.makeWorker")(function* (
  target: ArtifactRuntimeTarget,
  host: ArtifactRuntimeHost,
  callingSessionId?: string,
  windowConnectionId?: number,
) {
  const storage = yield* ArtifactStorage;
  const clientEvents = yield* ClientEvents;
  const context = yield* Effect.context<never>();
  const run = Effect.runPromiseExitWith(context);
  const bridge = async <A>(effect: Effect.Effect<A, ArtifactRuntimeError>, signal: AbortSignal) => {
    const exit = await run(effect, { signal });
    if (Exit.isSuccess(exit)) return exit.value;
    throw new Error(Cause.pretty(exit.cause));
  };
  const ready = yield* Deferred.make<void, ArtifactRuntimeError>();
  const events = yield* Queue.unbounded<Event>();
  let currentSessionId = callingSessionId;
  let currentWindowConnectionId = windowConnectionId;
  let active: Deferred.Deferred<Schema.Json, ArtifactRuntimeError> | undefined;
  let ended: ArtifactRuntimeError | undefined;
  let running = true;
  const sandbox = yield* Effect.acquireRelease(
    Effect.sync(
      () =>
        new CodemodeSandbox({
          timeoutMs: Infinity,
          memoryLimitBytes: 64 * 1024 * 1024,
          // Globals are not accumulated in Codemode's diagnostic tool-call history.
          globals: [
            {
              name: "__artifactReady",
              execute: (_input, { signal }) =>
                bridge(
                  Effect.gen(function* () {
                    currentSessionId = undefined;
                    currentWindowConnectionId = undefined;
                    yield* Deferred.succeed(ready, undefined);
                    return null;
                  }),
                  signal,
                ),
            },
            {
              name: "__artifactNext",
              execute: (_input, { signal }) =>
                bridge(
                  Queue.take(events).pipe(
                    Effect.tap((event) =>
                      Effect.sync(() => {
                        currentSessionId = event.callingSessionId;
                        currentWindowConnectionId = event.windowConnectionId;
                      }),
                    ),
                  ),
                  signal,
                ),
            },
            {
              name: "__artifactComplete",
              execute: (input, { signal }) =>
                bridge(
                  Effect.gen(function* () {
                    const completion = yield* Schema.decodeUnknownEffect(Completion)(input).pipe(
                      Effect.mapError((cause) => failure("result", cause)),
                    );
                    const pending = active;
                    active = undefined;
                    currentSessionId = undefined;
                    currentWindowConnectionId = undefined;
                    if (pending) {
                      if (completion.ok) yield* Deferred.succeed(pending, completion.value);
                      else yield* Deferred.fail(pending, failure("handler", completion.message));
                    }
                    return null;
                  }),
                  signal,
                ),
            },
            {
              name: "__artifactCake",
              execute: (input, { signal }) =>
                bridge(
                  Schema.decodeUnknownEffect(CakeRequest)(input).pipe(
                    Effect.mapError((cause) => failure("cake", cause)),
                    Effect.flatMap((request) =>
                      host.invokeCommand({
                        lineageId: target.lineageId,
                        ...request,
                        ...(currentSessionId === undefined
                          ? null
                          : { callingSessionId: currentSessionId }),
                        ...(currentWindowConnectionId === undefined
                          ? null
                          : { windowConnectionId: currentWindowConnectionId }),
                      }),
                    ),
                    Effect.flatMap((value) => Schema.decodeUnknownEffect(Schema.Json)(value)),
                    Effect.mapError((cause) => failure("cake", cause)),
                  ),
                  signal,
                ),
            },
            {
              name: "__artifactRead",
              execute: (_input, { signal }) =>
                bridge(
                  storage.readState(target.lineageId).pipe(
                    Effect.map((state) => state.value),
                    Effect.mapError((cause) => failure("data.read", cause)),
                  ),
                  signal,
                ),
            },
            {
              name: "__artifactWrite",
              execute: (input, { signal }) =>
                bridge(
                  Effect.gen(function* () {
                    const value = yield* Schema.decodeUnknownEffect(Schema.Json)(input);
                    const current = yield* storage.readState(target.lineageId);
                    yield* storage.replaceState({
                      lineageId: target.lineageId,
                      expectedVersion: current.version,
                      value,
                    });
                    clientEvents.broadcast({
                      type: "artifact-state-invalidated",
                      lineageId: target.lineageId,
                    });
                    return null;
                  }).pipe(Effect.mapError((cause) => failure("data.write", cause))),
                  signal,
                ),
            },
          ],
        }),
    ),
    (instance) => Effect.promise(() => instance.close()),
  );
  // This scope, not the requesting view or RPC call, owns the worker.
  yield* Effect.tryPromise({
    try: (signal) => sandbox.execute(program(target.runtime.source), { signal }),
    catch: (cause) => failure("worker", cause),
  }).pipe(
    Effect.flatMap((result) =>
      Effect.sync(() =>
        result.ok
          ? failure("worker", "Artifact runtime stopped")
          : failure("worker", result.error.stack ?? result.error.message),
      ),
    ),
    Effect.catch((error) => Effect.succeed(error)),
    Effect.flatMap((error) =>
      Effect.gen(function* () {
        running = false;
        ended = error;
        yield* Deferred.fail(ready, error);
        if (active) yield* Deferred.fail(active, error);
      }),
    ),
    Effect.onInterrupt(() =>
      Effect.gen(function* () {
        running = false;
        ended = failure("worker", "Artifact runtime stopped");
        yield* Deferred.fail(ready, ended);
        if (active) yield* Deferred.fail(active, ended);
      }),
    ),
    Effect.forkScoped,
  );
  yield* Deferred.await(ready);
  const send = Effect.fn("ArtifactRuntime.send")(function* (event: Event) {
    if (ended) return yield* ended;
    const pending = yield* Deferred.make<Schema.Json, ArtifactRuntimeError>();
    active = pending;
    yield* Queue.offer(events, event);
    return yield* Deferred.await(pending);
  });
  return { send, isRunning: () => running, lastError: () => ended?.message };
});
