import { Schema } from "effect";
import { RpcClientError } from "effect/unstable/rpc";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RendererSynchronizationSupervisor } from "../../../src/renderer/RendererSynchronizationSupervisor";

describe("RendererSynchronizationSupervisor", () => {
  afterEach(() => vi.useRealTimers());

  it("does not retry a local or decoded remote schema failure", async () => {
    vi.useFakeTimers();
    const supervisor = new RendererSynchronizationSupervisor();
    const reportFailure = vi.fn();
    const run = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(schemaError())
      .mockRejectedValueOnce(
        Object.assign(new Error("Expected JSON value"), { name: "SchemaError" }),
      );

    supervisor.register("local", { run, reportFailure });
    await Promise.resolve();
    await Promise.resolve();
    expect(reportFailure).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(run).toHaveBeenCalledOnce();

    const remoteRun = vi
      .fn<() => Promise<void>>()
      .mockRejectedValue(Object.assign(new Error("Expected JSON value"), { name: "SchemaError" }));
    supervisor.register("remote", { run: remoteRun, reportFailure });
    await vi.waitFor(() => expect(remoteRun).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(60_000);
    expect(remoteRun).toHaveBeenCalledOnce();
    supervisor[Symbol.dispose]();
  });

  it("coordinates one reconnect for all streams after a transport failure", async () => {
    vi.useFakeTimers();
    const supervisor = new RendererSynchronizationSupervisor();
    const firstRun = vi.fn(() => Promise.reject(transportError()));
    const secondRun = vi.fn((signal: AbortSignal) => untilAborted(signal));
    const reportFailure = vi.fn();
    supervisor.register("first", { run: firstRun, reportFailure });
    supervisor.register("second", { run: secondRun, reportFailure });

    await Promise.resolve();
    await Promise.resolve();
    expect(reportFailure).toHaveBeenCalledOnce();
    expect(firstRun).toHaveBeenCalledOnce();
    expect(secondRun).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(249);
    expect(firstRun).toHaveBeenCalledOnce();
    expect(secondRun).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(firstRun).toHaveBeenCalledTimes(2);
    expect(secondRun).toHaveBeenCalledTimes(2);
    supervisor[Symbol.dispose]();
  });

  it("backs off and reports one failure until a stream becomes healthy", async () => {
    vi.useFakeTimers();
    const supervisor = new RendererSynchronizationSupervisor();
    const reportFailure = vi.fn();
    const run = vi.fn((_signal: AbortSignal, markHealthy: () => void) => {
      if (run.mock.calls.length < 3) return Promise.reject(new Error("temporary"));
      markHealthy();
      return new Promise<void>(() => undefined);
    });
    supervisor.register("stream", { run, reportFailure });

    await vi.advanceTimersByTimeAsync(250);
    expect(run).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(499);
    expect(run).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(3);
    expect(reportFailure).toHaveBeenCalledOnce();
    supervisor[Symbol.dispose]();
  });
});

const schemaError = () => {
  try {
    Schema.decodeUnknownSync(Schema.Json)(undefined);
  } catch (error) {
    return error;
  }
  throw new Error("Expected Schema.Json to reject undefined");
};

const transportError = () =>
  new RpcClientError.RpcClientError({
    reason: new RpcClientError.RpcClientDefect({
      message: "transport failed",
      cause: new Error("offline"),
    }),
  });

const untilAborted = (signal: AbortSignal) =>
  new Promise<void>((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
