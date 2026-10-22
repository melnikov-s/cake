import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { Cause, Effect, Exit, Layer, Schema } from "effect";
import { WorkflowAgentInput, WorkflowError } from "../../../contracts/workflows/workflow-data";
import { WorkflowSandbox, type WorkflowScriptHost } from "../WorkflowSandbox";
import { parseWorkflowProgram } from "../runtime/workflow-program";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const boundaryError = (error: unknown) =>
  new WorkflowError({ operation: "sandbox", reason: "sandbox", message: message(error) });
const titleSchema = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));
const logSchema = Schema.String.check(Schema.isMaxLength(4096));

// These helpers execute inside QuickJS. Host capabilities remain closed over by the prelude.
const prelude = `
const args = __workflowArgs;
const agent = async (prompt, options = {}) => {
  const reply = await tools.agent({ prompt, options });
  if (!reply.ok) {
    const error = new Error(reply.message);
    error.workflowWorkerFailure = reply.workerFailure;
    throw error;
  }
  return reply.result;
};
const batch = async (items, callback) => {
  if (!Array.isArray(items) || items.length > 4096) throw new Error("Workflow helpers accept at most 4096 items.");
  return await Promise.all(items.map(async (item, index) => {
    try { return await callback(item, index); }
    catch (error) { if (error.workflowWorkerFailure) return null; throw error; }
  }));
};
const pipeline = (items, callback) => batch(items, callback);
const parallel = (tasks) => batch(tasks, (task) => task());
const phase = (title) => tools.phase(title);
const log = (message) => tools.log(message);
// Pi 1.4 freezes VM intrinsics before user code. Keep workflow helpers lexical
// instead of trying to rewrite Date.prototype or the global Math object.
const { Date, Math } = (() => {
  const OriginalDate = globalThis.Date;
  const denyClock = () => { throw new Error("Workflow clock/random access is disabled; pass timestamps through args."); };
  const SafeDate = function (...values) {
    if (!new.target || !values.length) return denyClock();
    return Reflect.construct(OriginalDate, values);
  };
  Object.defineProperties(SafeDate, {
    now: { value: denyClock },
    parse: { value: OriginalDate.parse },
    UTC: { value: OriginalDate.UTC },
  });
  const math = Object.create(null, {
    ...Object.getOwnPropertyDescriptors(globalThis.Math),
    random: { value: denyClock },
  });
  return { Date: Object.freeze(SafeDate), Math: Object.freeze(math) };
})();
`;

export const WorkflowSandboxLive = Layer.succeed(
  WorkflowSandbox,
  WorkflowSandbox.of({
    execute: Effect.fn("WorkflowSandbox.execute")(function* (program, host: WorkflowScriptHost) {
      const parsed = yield* Effect.try({
        try: () => parseWorkflowProgram(program.source),
        catch: boundaryError,
      });
      const context = yield* Effect.context<never>();
      const run = Effect.runPromiseExitWith(context);
      // Native promises are tracked only to await bridge cleanup, not as scheduler state.
      const pending = new Set<Promise<unknown>>();
      const bridge = <A>(effect: Effect.Effect<A, WorkflowError>, signal: AbortSignal) => {
        const promise = run(effect, { signal });
        pending.add(promise);
        void promise.finally(() => pending.delete(promise));
        return promise;
      };
      const scalar = <A>(effect: Effect.Effect<A, WorkflowError>, signal: AbortSignal) =>
        bridge(effect, signal).then((exit) => {
          if (Exit.isSuccess(exit)) return exit.value ?? null;
          throw new Error(Cause.pretty(exit.cause));
        });
      const sandbox = yield* Effect.acquireRelease(
        Effect.sync(
          () =>
            new CodemodeSandbox({
              timeoutMs: Infinity,
              memoryLimitBytes: 64 * 1024 * 1024,
              tools: [
                {
                  name: "agent",
                  execute: async (input, { signal }) => {
                    const exit = await bridge(
                      Schema.decodeUnknownEffect(WorkflowAgentInput)(input).pipe(
                        Effect.mapError(
                          (error) =>
                            new WorkflowError({
                              operation: "agent",
                              reason: "invalid-input",
                              message: error.message,
                            }),
                        ),
                        Effect.flatMap((value) => host.agent(value, "throw")),
                      ),
                      signal,
                    );
                    if (Exit.isSuccess(exit)) return { ok: true, result: exit.value };
                    const error = Cause.findErrorOption(exit.cause);
                    if (error._tag === "Some")
                      return {
                        ok: false,
                        message: error.value.message,
                        workerFailure: ["worker", "stalled", "invalid-output"].includes(
                          error.value.reason,
                        ),
                      };
                    throw new Error(Cause.pretty(exit.cause));
                  },
                },
                {
                  name: "phase",
                  execute: (input, { signal }) =>
                    scalar(
                      Schema.decodeUnknownEffect(titleSchema)(input).pipe(
                        Effect.mapError(boundaryError),
                        Effect.flatMap(host.phase),
                      ),
                      signal,
                    ),
                },
                {
                  name: "log",
                  execute: (input, { signal }) =>
                    scalar(
                      Schema.decodeUnknownEffect(logSchema)(input).pipe(
                        Effect.mapError(boundaryError),
                        Effect.flatMap(host.log),
                      ),
                      signal,
                    ),
                },
              ],
            }),
        ),
        (instance) =>
          Effect.promise(async () => {
            await instance.close();
            await Promise.allSettled(pending);
          }),
      );
      const code = `const __workflowArgs = ${JSON.stringify(program.args) ?? "undefined"};\n${prelude}\n${parsed.body}`;
      const result = yield* Effect.tryPromise({
        try: async (parentSignal) => {
          const calls = new AbortController();
          const signal = AbortSignal.any([parentSignal, calls.signal]);
          let sequence = 0;
          // Pi owns the frozen globals. Fix the VM clock/seed too, so aliases
          // that bypass the lexical workflow guards cannot read real time/randomness.
          const execution = sandbox.start(code, {
            startedAt: 0,
            seed: 0,
            signal,
            tools: sandbox.tools,
            onCall(call) {
              const tool = sandbox.tools.find((entry) => entry.name === call.name);
              void Promise.resolve()
                .then(() => {
                  if (!tool) throw new Error(`Unknown workflow helper: ${call.name}`);
                  return tool.execute(call.args, { signal });
                })
                .then(
                  (value) => {
                    if (!execution.finished)
                      execution.deliver(++sequence, 0, call.id, { ok: true, value });
                  },
                  (error: unknown) => {
                    if (!execution.finished)
                      execution.deliver(++sequence, 0, call.id, {
                        ok: false,
                        message: message(error),
                      });
                  },
                );
            },
          });
          try {
            return await execution.result;
          } finally {
            calls.abort();
          }
        },
        catch: boundaryError,
      });
      if (!result.ok)
        return yield* new WorkflowError({
          operation: "execute",
          reason: result.error.kind === "script" ? "script" : "sandbox",
          message: result.error.stack ?? result.error.message,
        });
      if (result.value === undefined) return undefined;
      return yield* Schema.decodeUnknownEffect(Schema.Json)(result.value).pipe(
        Effect.mapError(boundaryError),
      );
    }),
  }),
);
