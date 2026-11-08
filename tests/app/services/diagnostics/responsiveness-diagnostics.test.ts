import { it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Logger } from "effect";
import { TestClock } from "effect/testing";
import { expect } from "vitest";
import { measureLanding } from "../../../../src/services/diagnostics/responsiveness-diagnostics";
import { GitError } from "../../../../src/services/git/Git";

it.effect(
  "times Git/cleanup success, original failures and interruption without leaking error bodies",
  () =>
    Effect.gen(function* () {
      const records: unknown[] = [];
      yield* Effect.gen(function* () {
        expect(
          yield* measureLanding(
            "landing",
            "git-execution",
            TestClock.adjust(50).pipe(Effect.as(42)),
          ),
        ).toBe(42);
        const error = new GitError({
          operation: "git secret argument",
          workingDirectory: "/private",
          message: "secret failure body",
        });
        const failed = yield* measureLanding(
          "landing",
          "resolution-cleanup",
          TestClock.adjust(30).pipe(Effect.andThen(Effect.fail(error))),
        ).pipe(Effect.result);
        expect(failed).toMatchObject({ _tag: "Failure", failure: error });
        const started = yield* Deferred.make<void>();
        const waiting = yield* measureLanding(
          "landing",
          "queue-wait",
          Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
        ).pipe(Effect.forkScoped);
        yield* Deferred.await(started);
        yield* TestClock.adjust(70);
        yield* Fiber.interrupt(waiting);
      }).pipe(Effect.provide(Logger.layer([Logger.make((event) => records.push(event.message))])));
      expect(records).toHaveLength(6);
      expect(records[1]).toMatchObject([
        "Cake landing",
        { phase: "git-execution", status: "succeeded", durationMs: 50 },
      ]);
      expect(records[3]).toMatchObject([
        "Cake landing",
        { phase: "resolution-cleanup", status: "failed", durationMs: 30, causeType: "GitError" },
      ]);
      expect(records[5]).toMatchObject([
        "Cake landing",
        { phase: "queue-wait", status: "canceled", durationMs: 70 },
      ]);
      expect(JSON.stringify(records)).not.toMatch(/secret|\/private/);
    }),
);
