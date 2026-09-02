import { it } from "@effect/vitest";
import { Effect, Fiber, Stream } from "effect";
import { describe, expect } from "vitest";
import { AgentAvailability } from "../../../../src/services/pi/AgentAvailability";

describe("AgentAvailability", () => {
  it.effect("publishes the current state before ordered workspace changes", () =>
    Effect.gen(function* () {
      const availability = yield* AgentAvailability;
      const observer = yield* availability
        .changes()
        .pipe(Stream.take(3), Stream.runCollect, Effect.forkChild);
      yield* Effect.yieldNow;
      yield* availability.setWorkingDirectory("/project", { state: "reloading" });
      yield* availability.setWorkingDirectory("/project", {
        state: "unavailable",
        reason: "reload failed",
      });
      const snapshots = yield* Fiber.join(observer);

      expect([...snapshots]).toEqual([
        { revision: 0, global: { state: "available" }, workingDirectories: [] },
        {
          revision: 1,
          global: { state: "available" },
          workingDirectories: [
            { workingDirectory: "/project", availability: { state: "reloading" } },
          ],
        },
        {
          revision: 2,
          global: { state: "available" },
          workingDirectories: [
            {
              workingDirectory: "/project",
              availability: { state: "unavailable", reason: "reload failed" },
            },
          ],
        },
      ]);
    }).pipe(Effect.provide(AgentAvailability.layer)),
  );
});
