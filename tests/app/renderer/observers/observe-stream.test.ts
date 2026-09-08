import { Effect, Schema, Stream } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CakeIpcClient, type CakeIpcClientService } from "../../../../src/ipc/client/CakeIpcClient";
import type { Runtime } from "../../../../src/renderer/runtime";
import { observeStream } from "../../../../src/renderer/observers";

const client = {} as CakeIpcClientService;
const execute: Runtime["execute"] = (effect, signal) =>
  Effect.runPromise(
    Effect.provideService(effect, CakeIpcClient, client),
    signal ? { signal } : undefined,
  );

describe("observeStream", () => {
  afterEach(() => vi.useRealTimers());

  it("retries a failed stream with Effect backoff", async () => {
    vi.useFakeTimers();
    const failure = schemaError();
    const reportFailure = vi.fn();
    const consume = vi.fn();
    let attempts = 0;

    const stop = observeStream(
      execute,
      () => {
        attempts += 1;
        return attempts === 1
          ? Stream.fail(failure)
          : Stream.concat(Stream.make("ready"), Stream.never);
      },
      consume,
      { reportFailure },
    );

    await vi.waitFor(() => expect(reportFailure).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(250);
    await vi.waitFor(() => expect(consume).toHaveBeenCalledWith("ready"));
    expect(attempts).toBe(2);
    stop();
  });

  it("retries streams independently", async () => {
    vi.useFakeTimers();
    let failingAttempts = 0;
    let healthyAttempts = 0;

    const stopFailing = observeStream(
      execute,
      () => {
        failingAttempts += 1;
        return failingAttempts === 1
          ? Stream.fail(new Error("offline"))
          : Stream.concat(Stream.make("recovered"), Stream.never);
      },
      () => undefined,
      { reportFailure: () => undefined },
    );
    const stopHealthy = observeStream(
      execute,
      () => {
        healthyAttempts += 1;
        return Stream.concat(Stream.make("ready"), Stream.never);
      },
      () => undefined,
      { reportFailure: () => undefined },
    );

    await vi.advanceTimersByTimeAsync(250);
    await vi.waitFor(() => expect(failingAttempts).toBe(2));
    expect(healthyAttempts).toBe(1);
    stopFailing();
    stopHealthy();
  });

  it("resets reconnect backoff after a stream emits a value", async () => {
    vi.useFakeTimers();
    const consume = vi.fn();
    let attempts = 0;
    const attemptTimes: Array<number> = [];

    const stop = observeStream(
      execute,
      () => {
        attempts += 1;
        attemptTimes.push(Date.now());
        if (attempts === 1) return Stream.fail(new Error("offline"));
        if (attempts === 2)
          return Stream.concat(Stream.make("healthy"), Stream.fail(new Error("disconnected")));
        return Stream.concat(Stream.make("recovered"), Stream.never);
      },
      consume,
      { reportFailure: () => undefined },
    );

    await vi.waitFor(() => expect(attempts).toBe(1));
    await vi.advanceTimersToNextTimerAsync();
    await vi.waitFor(() => expect(consume).toHaveBeenCalledWith("healthy"));
    expect(attempts).toBe(2);

    await vi.advanceTimersToNextTimerAsync();
    await vi.waitFor(() => expect(consume).toHaveBeenCalledWith("recovered"));
    expect(attempts).toBe(3);
    const [firstAttempt, secondAttempt, thirdAttempt] = attemptTimes;
    if (firstAttempt === undefined || secondAttempt === undefined || thirdAttempt === undefined)
      throw new Error("Expected three reconnect attempts");
    expect(thirdAttempt - secondAttempt).toBeLessThanOrEqual(secondAttempt - firstAttempt + 5);
    stop();
  });

  it("reports consumer defects as stopped and does not automatically replay them", async () => {
    vi.useFakeTimers();
    const failure = new Error("Invalid projection");
    const onStopped = vi.fn();
    const reportFailure = vi.fn();
    const source = vi.fn(() => Stream.make("snapshot"));
    const stop = observeStream(
      execute,
      source,
      () => {
        throw failure;
      },
      { onStopped, reportFailure },
    );
    await vi.waitFor(() => expect(onStopped).toHaveBeenCalledWith(failure));
    await vi.advanceTimersByTimeAsync(1000);
    expect(source).toHaveBeenCalledOnce();
    expect(reportFailure).toHaveBeenCalledOnce();
    stop();
  });

  it("does not report cancellation as a stopped observation", async () => {
    const onStopped = vi.fn();
    const reportFailure = vi.fn();
    const stop = observeStream(
      execute,
      () => Stream.never,
      () => undefined,
      { onStopped, reportFailure },
    );
    stop();
    await Promise.resolve();
    expect(onStopped).not.toHaveBeenCalled();
    expect(reportFailure).not.toHaveBeenCalled();
  });

  it("does not retry failures classified as terminal", async () => {
    vi.useFakeTimers();
    const reportFailure = vi.fn();
    let attempts = 0;

    const stop = observeStream(
      execute,
      () => {
        attempts += 1;
        return Stream.fail(new Error("gone"));
      },
      () => undefined,
      { classifyFailure: () => "stop", reportFailure },
    );

    await vi.waitFor(() => expect(reportFailure).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(1_000);
    expect(attempts).toBe(1);
    stop();
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
