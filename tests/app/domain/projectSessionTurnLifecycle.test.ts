import { it } from "@effect/vitest";
import { Cause, Effect, Exit, Layer } from "effect";
import { expect, vi } from "vitest";
import { makeTurnLifecycle } from "../../../src/domain/project-sessions/projectSessionTurnLifecycle";
import { ApplicationWriteError } from "../../../src/contracts/storage/application-storage-errors";
import { ProjectSessionConfiguration } from "../../../src/services/project-sessions/ProjectSessionConfiguration";
import { SessionCatalogChanges } from "../../../src/services/session-catalogs/SessionCatalogChanges";
import { SessionCoordination } from "../../../src/services/session-catalogs/SessionCoordination";
import { ApplicationState } from "../../../src/services/storage/ApplicationState";
import { ApplicationStorage } from "../../../src/services/storage/ApplicationStorage";
import {
  SessionArchiveStorage,
  SessionArchiveStorageError,
} from "../../../src/services/storage/SessionArchiveStorage";
import { SessionFamilyStorage } from "../../../src/services/storage/SessionFamilyStorage";

const location = {
  projectPath: "/project",
  projectName: "Project",
  workingDirectory: "/project",
  sessionDirectory: "/sessions",
  resolvedSessionDirectory: "/resolved",
};

const fixture = Effect.fn("ProjectSessionTurnLifecycleTest.fixture")((options: {
  readonly locate?: ReturnType<SessionArchiveStorage["Service"]["locate"]>;
  readonly save?: ReturnType<ApplicationStorage["Service"]["save"]>;
}) => {
  const publish =
    vi.fn<(change: Parameters<SessionCatalogChanges["Service"]["publish"]>[0]) => void>();
  const settle = vi.fn(() => Effect.void);
  const coordinate = vi.fn(() => Effect.void);
  const save = vi.fn(() => options.save ?? Effect.void);
  const dependencies = Layer.mergeAll(
    ApplicationState.layer.pipe(Layer.provide(Layer.mock(ApplicationStorage, { save }))),
    Layer.succeed(ProjectSessionConfiguration, {
      agentDirectory: "/cake",
      sessionDirectory: location.sessionDirectory,
      resolvedSessionDirectory: location.resolvedSessionDirectory,
    }),
    Layer.mock(SessionArchiveStorage, {
      locate: () => options.locate ?? Effect.succeed("active"),
    }),
    Layer.mock(SessionFamilyStorage, {
      familyForMember: () => Effect.succeed(undefined),
      state: () => Effect.succeed({ families: [], turns: [], spawnedSessions: [] }),
      settleTurn: settle,
    }),
    Layer.mock(SessionCatalogChanges, { publish: (change) => Effect.sync(() => publish(change)) }),
    Layer.mock(SessionCoordination, { settleTurn: coordinate }),
  );
  return Effect.succeed({ dependencies, publish, settle, coordinate, save });
});

it.effect.each([
  { outcome: "complete" as const, resolved: false, unread: true },
  { outcome: "failed" as const, resolved: false, unread: true },
  { outcome: "aborted" as const, resolved: false, unread: false },
  { outcome: "complete" as const, resolved: true, unread: false },
])("marks only finished active turns unread before settlement (%j)", (scenario) =>
  Effect.gen(function* () {
    const test = yield* fixture({
      locate: Effect.succeed(scenario.resolved ? "resolved" : "active"),
    });
    yield* Effect.gen(function* () {
      const hooks = yield* makeTurnLifecycle({ sessionId: "session", location });
      yield* hooks.onTurnSettled({
        sessionId: "session",
        turnId: "turn",
        outcome: scenario.outcome,
      });
      const state = yield* (yield* ApplicationState).current();
      expect(state.unreadSessionIds).toEqual(scenario.unread ? ["session"] : []);
      expect(test.publish).toHaveBeenCalledTimes(scenario.unread ? 1 : 0);
      if (scenario.unread)
        expect(test.publish).toHaveBeenCalledWith({
          _tag: "ProjectSessionActivityChanged",
          sessionId: "session",
          projectPath: "/project",
          workingDirectory: "/project",
          sessionDirectory: "/sessions",
        });
      if (scenario.unread)
        expect(test.publish.mock.invocationCallOrder[0]).toBeLessThan(
          test.settle.mock.invocationCallOrder[0] ?? 0,
        );
      expect(test.settle).toHaveBeenCalledWith("turn", scenario.outcome, undefined, undefined);
      expect(test.coordinate).toHaveBeenCalledWith("turn", scenario.outcome);
    }).pipe(Effect.provide(test.dependencies));
  }),
);

it.effect.each(["archive", "persistence"] as const)(
  "continues settlement after expected unread %s failure",
  (boundary) =>
    Effect.gen(function* () {
      const test = yield* fixture(
        boundary === "archive"
          ? {
              locate: Effect.fail(
                new SessionArchiveStorageError({
                  operation: "locate",
                  sessionId: "session",
                  message: "Unavailable archive",
                }),
              ),
            }
          : {
              save: Effect.fail(
                new ApplicationWriteError({ stage: "write", message: "Disk unavailable" }),
              ),
            },
      );
      yield* Effect.gen(function* () {
        const hooks = yield* makeTurnLifecycle({ sessionId: "session", location });
        yield* hooks.onTurnSettled({ sessionId: "session", turnId: "turn", outcome: "complete" });
        expect(test.settle).toHaveBeenCalledOnce();
        expect(test.publish).not.toHaveBeenCalled();
        expect((yield* (yield* ApplicationState).current()).unreadSessionIds).toEqual([]);
      }).pipe(Effect.provide(test.dependencies));
    }),
);

it.effect.each(["defect", "interruption"] as const)(
  "preserves unread %s rather than reporting successful settlement",
  (failure) =>
    Effect.gen(function* () {
      const defect = new Error("Broken archive implementation");
      const test = yield* fixture({
        locate: failure === "defect" ? Effect.die(defect) : Effect.interrupt,
      });
      yield* Effect.gen(function* () {
        const hooks = yield* makeTurnLifecycle({ sessionId: "session", location });
        const exit = yield* Effect.exit(
          hooks.onTurnSettled({ sessionId: "session", turnId: "turn", outcome: "complete" }),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(Cause.hasInterrupts(exit.cause)).toBe(failure === "interruption");
          expect(Cause.hasDies(exit.cause)).toBe(failure === "defect");
        }
        expect(test.settle).not.toHaveBeenCalled();
        expect(test.publish).not.toHaveBeenCalled();
      }).pipe(Effect.provide(test.dependencies));
    }),
);
