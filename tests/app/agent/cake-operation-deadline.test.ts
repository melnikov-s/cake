import { Schema } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CakeOperationDefinition } from "../../../src/contracts/agent/cake-operation";
import {
  CAKE_OPERATION_DEADLINE_MS,
  withCakeOperationDeadline,
} from "../../../src/services/pi/runtime/cake-operation-deadline";
import { CakeOperationRegistry } from "../../../src/services/pi/runtime/cake-operation-registry";
import { createCakeToolDefinition } from "../../../src/services/pi/runtime/cake-session-runtime-capabilities";

const command = "sessions.mutate";
const context = (signal = new AbortController().signal) => ({
  signal,
  toolCallId: "deadline",
  runtime: {},
});
const operation = (execute: CakeOperationDefinition["execute"]): CakeOperationDefinition => ({
  command,
  topic: "sessions",
  summary: "Test operation",
  inputSchema: Schema.Struct({}),
  examples: [],
  result: "Receipt",
  execute,
});

// Attach a rejection observer immediately, before advancing timers.
const outcome = <A>(promise: Promise<A>) =>
  promise.then(
    (value) => ({ kind: "success" as const, value }),
    (error: unknown) => ({ kind: "failure" as const, error }),
  );

const runtime = {
  sessionManager: {
    getSessionId: () => "parent",
    getSessionFile: () => undefined,
    getLeafId: () => null,
    getBranch: () => [],
  },
} as never;

describe("Cake operation hard deadline", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("returns success and removes its timer and caller listener without aborting detached work", async () => {
    const caller = new AbortController();
    const remove = vi.spyOn(caller.signal, "removeEventListener");
    let workerSignal: AbortSignal | undefined;
    expect(
      await withCakeOperationDeadline(command, caller.signal, async (signal) => {
        workerSignal = signal;
        return "receipt";
      }),
    ).toBe("receipt");
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    caller.abort();
    await vi.advanceTimersByTimeAsync(CAKE_OPERATION_DEADLINE_MS * 2);
    expect(workerSignal?.aborted).toBe(false);
  });

  it.each([false, true])(
    "preserves rejection (synchronous=%s) and cleans up",
    async (synchronous) => {
      const failure = new Error("original failure");
      const execute = () => {
        if (synchronous) throw failure;
        return Promise.reject(failure);
      };
      await expect(withCakeOperationDeadline(command, context().signal, execute)).rejects.toBe(
        failure,
      );
    },
  );

  it.each([false, true])(
    "bounds a hung handler (cooperative=%s) through the registered Pi tool",
    async (cooperative) => {
      let handlerSignal: AbortSignal | undefined;
      const execute = vi.fn<CakeOperationDefinition["execute"]>((_input, { signal }) => {
        handlerSignal = signal;
        return new Promise<never>((_resolve, reject) => {
          if (cooperative)
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      });
      const caller = new AbortController();
      const remove = vi.spyOn(caller.signal, "removeEventListener");
      const tool = createCakeToolDefinition([operation(execute)]);
      const result = outcome(tool.execute("call", { command }, caller.signal, undefined, runtime));
      await vi.advanceTimersByTimeAsync(CAKE_OPERATION_DEADLINE_MS - 1);
      expect(handlerSignal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await result).toMatchObject({
        kind: "failure",
        error: {
          name: "TimeoutError",
          message: expect.stringContaining(`${command} timed out after 300000ms (5 minutes)`),
        },
      });
      expect(handlerSignal?.reason.message).toContain("rollback is not guaranteed");
      expect(handlerSignal?.reason.message).toContain("Inspect its state");
      expect(caller.signal.aborted).toBe(false);
      expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
      expect(execute).toHaveBeenCalledTimes(1);
    },
  );

  it("honors earlier caller cancellation even when the handler ignores abort", async () => {
    const caller = new AbortController();
    const reason = new DOMException("Caller stopped", "AbortError");
    let handlerSignal: AbortSignal | undefined;
    const result = outcome(
      withCakeOperationDeadline(command, caller.signal, (signal) => {
        handlerSignal = signal;
        return new Promise<never>(() => undefined);
      }),
    );
    caller.abort(reason);
    expect(await result).toEqual({ kind: "failure", error: reason });
    expect(handlerSignal?.reason).toBe(reason);
  });

  it("does not start an already-cancelled call", async () => {
    const caller = new AbortController();
    caller.abort();
    const execute = vi.fn();
    await expect(withCakeOperationDeadline(command, caller.signal, execute)).rejects.toBe(
      caller.signal.reason,
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it("preserves a handler's shorter deadline", async () => {
    const failure = new DOMException("CDP deadline", "TimeoutError");
    const registry = new CakeOperationRegistry([
      operation(
        () =>
          new Promise((_resolve, reject) => {
            setTimeout(() => reject(failure), 30_000);
          }),
      ),
    ]);
    const result = outcome(registry.invoke({ command }, context()));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await result).toEqual({ kind: "failure", error: failure });
  });

  it.each(["resolve", "reject"] as const)(
    "consumes late %s without projection, updates, replay or a changed outcome",
    async (settle) => {
      const pending = Promise.withResolvers<null>();
      const updates = vi.fn();
      const project = vi.fn(async () => null);
      let update: (() => void) | undefined;
      const execute = vi.fn<CakeOperationDefinition["execute"]>((_input, execution) => {
        update = () => execution.onUpdate?.("late update");
        return pending.promise;
      });
      const registry = new CakeOperationRegistry([operation(execute)], project);
      const result = outcome(registry.invoke({ command }, { ...context(), onUpdate: updates }));
      await vi.advanceTimersByTimeAsync(CAKE_OPERATION_DEADLINE_MS);
      const timeout = await result;
      update?.();
      if (settle === "resolve") pending.resolve(null);
      else pending.reject(new Error("late failure"));
      await vi.advanceTimersByTimeAsync(0);
      expect(await result).toBe(timeout);
      expect(project).not.toHaveBeenCalled();
      expect(updates).not.toHaveBeenCalled();
      expect(execute).toHaveBeenCalledTimes(1);
    },
  );

  it("does not undo or replay a mutation that commits before a lost receipt", async () => {
    const receipt = Promise.withResolvers<null>();
    const committed: string[] = [];
    const execute = vi.fn<CakeOperationDefinition["execute"]>(() => {
      committed.push("launched-session");
      return receipt.promise;
    });
    const registry = new CakeOperationRegistry([operation(execute)]);
    const result = outcome(registry.invoke({ command }, context()));
    await vi.advanceTimersByTimeAsync(CAKE_OPERATION_DEADLINE_MS);
    expect(await result).toMatchObject({ kind: "failure", error: { name: "TimeoutError" } });
    expect(committed).toEqual(["launched-session"]);
    receipt.resolve(null);
    await vi.advanceTimersByTimeAsync(0);
    expect(committed).toEqual(["launched-session"]);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("bounds result projection with the same budget as execution", async () => {
    let projectionSignal: AbortSignal | undefined;
    const registry = new CakeOperationRegistry([operation(async () => null)], (_value, signal) => {
      projectionSignal = signal;
      return new Promise<never>(() => undefined);
    });
    const result = outcome(registry.invoke({ command }, context()));
    await vi.advanceTimersByTimeAsync(CAKE_OPERATION_DEADLINE_MS);
    expect(projectionSignal?.aborted).toBe(true);
    expect(await result).toMatchObject({ kind: "failure", error: { name: "TimeoutError" } });
  });

  it("propagates the remaining parent budget to nested dispatch rather than resetting it", async () => {
    const inner = new CakeOperationRegistry([operation(() => new Promise<never>(() => undefined))]);
    const outer = new CakeOperationRegistry([
      operation(async (_input, execution) => {
        await new Promise((resolve) => setTimeout(resolve, 60_000));
        return (await inner.invoke({ command }, execution)).json;
      }),
    ]);
    const result = outcome(outer.invoke({ command }, context()));
    await vi.advanceTimersByTimeAsync(CAKE_OPERATION_DEADLINE_MS);
    expect(await result).toMatchObject({ kind: "failure", error: { name: "TimeoutError" } });
  });
});
