import { it } from "@effect/vitest";
import { Deferred, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { expect } from "vitest";
import {
  PiModelCompletionError,
  UnauthenticatedPiModelError,
  UnknownPiModelError,
} from "../../../../src/contracts/pi/model-data";
import {
  memoryWork,
  MemorySummaryError,
  retryMemoryCompletion,
} from "../../../../src/services/opt-memory/memory-work";

it.effect("retries a proven transient failure after bounded backoff, then succeeds", () =>
  Effect.gen(function* () {
    let calls = 0;
    const first = yield* Deferred.make<void>();
    const run = retryMemoryCompletion(async () => {
      calls += 1;
      if (calls === 1) {
        Effect.runSync(Deferred.succeed(first, undefined));
        throw new PiModelCompletionError({ message: "PRIVATE_BODY", category: "transient" });
      }
      return "Recovered";
    });
    const fiber = yield* Effect.forkChild(run);
    yield* Deferred.await(first);
    yield* TestClock.adjust(249);
    expect(calls).toBe(1);
    yield* TestClock.adjust(1);
    expect(yield* Fiber.join(fiber)).toBe("Recovered");
    expect(calls).toBe(2);
  }),
);

it.effect("exhausts the transient retry budget without exposing the provider body", () =>
  Effect.gen(function* () {
    let calls = 0;
    const fiber = yield* Effect.forkChild(
      Effect.flip(
        retryMemoryCompletion(async () => {
          calls += 1;
          throw new PiModelCompletionError({
            message: "SECRET_TOKEN PRIVATE_BODY",
            category: "transient",
          });
        }),
      ),
    );
    yield* TestClock.adjust(250);
    const error = yield* Fiber.join(fiber);
    expect(calls).toBe(2);
    expect(error.reason).toBe("transient");
    expect(JSON.stringify(error)).not.toMatch(/SECRET_TOKEN|PRIVATE_BODY/);
  }),
);

it.effect.each([
  new UnknownPiModelError({ provider: "fixture", modelId: "missing" }),
  new UnauthenticatedPiModelError({ provider: "fixture", modelId: "fixture" }),
  new PiModelCompletionError({ message: "PRIVATE_BODY", category: "tool-output" }),
  new MemorySummaryError({ reason: "empty-summary" }),
  new Error("429 in unknown error text is not proof of transience"),
])("does not retry permanent, empty, tool-only or unclassified failures %#", (error) =>
  Effect.gen(function* () {
    let calls = 0;
    const failure = yield* Effect.flip(
      retryMemoryCompletion(async () => {
        calls += 1;
        throw error;
      }),
    );
    expect(calls).toBe(1);
    expect(JSON.stringify(failure)).not.toContain("PRIVATE_BODY");
  }),
);

it.effect("interrupts backoff before a second provider call", () =>
  Effect.gen(function* () {
    let calls = 0;
    const first = yield* Deferred.make<void>();
    const fiber = yield* Effect.forkChild(
      retryMemoryCompletion(async () => {
        calls += 1;
        Effect.runSync(Deferred.succeed(first, undefined));
        throw new MemorySummaryError({ reason: "transient" });
      }),
    );
    yield* Deferred.await(first);
    yield* TestClock.adjust(100);
    yield* Fiber.interrupt(fiber);
    yield* TestClock.adjust(1_000);
    expect(calls).toBe(1);
  }),
);

it.effect("opens a per-pass circuit for permanent configuration failures", () =>
  Effect.promise(async () => {
    const work = memoryWork(new AbortController().signal);
    let calls = 0;
    const operation = async () => {
      calls += 1;
      throw new UnknownPiModelError({ provider: "fixture", modelId: "missing" });
    };
    await expect(work.complete(operation)).rejects.toMatchObject({ reason: "configuration" });
    await expect(work.complete(operation)).rejects.toMatchObject({ reason: "configuration" });
    expect(calls).toBe(1);
  }),
);
