import { NodeFileSystem } from "@effect/platform-node";
import { NodePath } from "@effect/platform-node-shared";
import { describe, expect, it } from "@effect/vitest";
import { Context, Deferred, Effect, Fiber, Layer, Ref, Schema } from "effect";
import { TestClock } from "effect/testing";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactLineageId } from "../../../src/contracts/artifacts/artifact-lineage";
import type {
  ArtifactSchedule,
  ArtifactScheduleConfigureInput,
} from "../../../src/contracts/artifacts/artifact-schedules";
import {
  areArtifactSchedulesPaused,
  configureArtifactSchedule,
  listArtifactSchedules,
  removeArtifactSchedule,
  removeArtifactSchedules,
  runArtifactSchedulePass,
  setArtifactSchedulesPaused,
} from "../../../src/domain/automations/artifactSchedules";
import { runSchedulePass } from "../../../src/domain/automations/automationWorker";
import { automationFixture } from "../helpers/automationFixture";
import { AutomationRecords } from "../../../src/services/automations/AutomationRecords";
import { ClientEventsLive } from "../../../src/services/clients/ClientEventsLive";
import {
  AutomationStorage,
  makeAutomationStorageLive,
  type AutomationLedger,
} from "../../../src/services/storage/AutomationStorage";

const lineageId = Schema.decodeUnknownSync(ArtifactLineageId)("weather");
const otherId = Schema.decodeUnknownSync(ArtifactLineageId)("other");
const empty: AutomationLedger = {
  automations: [],
  occurrences: [],
  runs: [],
  artifactSchedules: [],
  pausedArtifactIds: [],
};
const input = (
  overrides: Partial<ArtifactScheduleConfigureInput> = {},
): ArtifactScheduleConfigureInput => ({
  lineageId,
  name: "refresh",
  handler: "refresh",
  input: { city: "Boston" },
  schedule: { _tag: "Interval", startsAt: "2030-01-01T00:01:00.000Z", everySeconds: 60 },
  ...overrides,
});

const fixture = Effect.fn("ArtifactScheduleTest.fixture")(function* (
  persisted: Ref.Ref<AutomationLedger>,
) {
  const recordsContext = yield* Layer.build(
    AutomationRecords.layer.pipe(
      Layer.provide(
        Layer.succeed(AutomationStorage, {
          load: () => Ref.get(persisted),
          save: (ledger) => Ref.set(persisted, ledger),
        }),
      ),
    ),
  );
  const context = Context.merge(recordsContext, yield* Layer.build(ClientEventsLive));
  const records = Context.get(context, AutomationRecords);
  yield* records.initialize();
  return { context, records };
});

const setup = Effect.fn("ArtifactScheduleTest.setup")(function* () {
  yield* TestClock.setTime(new Date("2030-01-01T00:00:00.000Z").getTime());
  const persisted = yield* Ref.make(empty);
  return { ...(yield* fixture(persisted)), persisted };
});

describe("deterministic artifact schedules", () => {
  it.effect("dispatches from the existing automation worker without starting Pi sessions", () =>
    Effect.gen(function* () {
      const f = yield* automationFixture();
      yield* TestClock.setTime(new Date("2030-01-01T00:00:00.000Z").getTime());
      yield* Effect.gen(function* () {
        yield* configureArtifactSchedule(input());
        yield* TestClock.adjust("1 minute");
        const invoked = yield* Ref.make(0);
        yield* runSchedulePass(() => Ref.update(invoked, (count) => count + 1));
        expect(yield* Ref.get(invoked)).toBe(1);
        expect(f.captured).toEqual([]);
        expect(f.records.snapshot().runs).toEqual([]);
      }).pipe(Effect.provide(f.context));
    }),
  );
  it.effect("reconfigures one stable identity without creating Pi occurrences or runs", () =>
    Effect.gen(function* () {
      const f = yield* setup();
      yield* Effect.gen(function* () {
        yield* configureArtifactSchedule(input());
        yield* configureArtifactSchedule(input({ handler: "updated", input: { city: "NYC" } }));
        yield* configureArtifactSchedule(input({ name: "second" }));
        yield* configureArtifactSchedule(input({ lineageId: otherId }));
        expect(yield* listArtifactSchedules(lineageId)).toHaveLength(2);
        expect(yield* listArtifactSchedules()).toHaveLength(3);
        expect((yield* listArtifactSchedules(lineageId))[0]?.handler).toBe("updated");
        expect(f.records.snapshot().occurrences).toEqual([]);
        expect(f.records.snapshot().runs).toEqual([]);
        yield* removeArtifactSchedule({ lineageId, name: "second" });
        expect(yield* listArtifactSchedules(lineageId)).toHaveLength(1);
      }).pipe(Effect.provide(f.context));
    }),
  );

  it.effect("does not run early and performs only one catch-up after backend restart", () =>
    Effect.gen(function* () {
      const f = yield* setup();
      const calls = yield* Ref.make<ReadonlyArray<ArtifactSchedule>>([]);
      const invoke = (schedule: ArtifactSchedule) => Ref.update(calls, (all) => [...all, schedule]);
      yield* configureArtifactSchedule(input()).pipe(Effect.provide(f.context));
      yield* runArtifactSchedulePass(invoke).pipe(Effect.provide(f.context));
      expect(yield* Ref.get(calls)).toHaveLength(0);
      // Backend is absent: advancing time alone cannot invoke anything.
      yield* TestClock.adjust("10 minutes");
      expect(yield* Ref.get(calls)).toHaveLength(0);
      const restarted = yield* fixture(f.persisted);
      yield* runArtifactSchedulePass(invoke).pipe(Effect.provide(restarted.context));
      expect(yield* Ref.get(calls)).toHaveLength(1);
      expect(restarted.records.snapshot().artifactSchedules[0]?.nextScheduledAt).toBe(
        "2030-01-01T00:11:00.000Z",
      );
      yield* runArtifactSchedulePass(invoke).pipe(Effect.provide(restarted.context));
      expect(yield* Ref.get(calls)).toHaveLength(1);
      yield* TestClock.adjust("1 minute");
      yield* runArtifactSchedulePass(invoke).pipe(Effect.provide(restarted.context));
      expect(yield* Ref.get(calls)).toHaveLength(2);
    }),
  );

  it.effect("persists explicit pause through restart and edits until explicit resume", () =>
    Effect.gen(function* () {
      const f = yield* setup();
      yield* Effect.gen(function* () {
        yield* setArtifactSchedulesPaused(lineageId, true);
        expect(yield* areArtifactSchedulesPaused(lineageId)).toBe(true);
        yield* configureArtifactSchedule(input());
        yield* configureArtifactSchedule(input({ handler: "edited-while-stopped" }));
      }).pipe(Effect.provide(f.context));
      yield* TestClock.adjust("10 minutes");
      const restarted = yield* fixture(f.persisted);
      const calls = yield* Ref.make(0);
      const invoke = () => Ref.update(calls, (n) => n + 1);
      yield* Effect.gen(function* () {
        // Listing/opening a view is read-only and cannot reactivate background work.
        expect((yield* listArtifactSchedules(lineageId))[0]?.paused).toBe(true);
        yield* runArtifactSchedulePass(invoke);
        expect(yield* Ref.get(calls)).toBe(0);
        yield* setArtifactSchedulesPaused(lineageId, false);
        yield* runArtifactSchedulePass(invoke);
        expect(yield* Ref.get(calls)).toBe(1);
      }).pipe(Effect.provide(restarted.context));
    }),
  );

  it.effect("captures admitted handler input while edits affect only future occurrences", () =>
    Effect.gen(function* () {
      const f = yield* setup();
      yield* configureArtifactSchedule(input()).pipe(Effect.provide(f.context));
      yield* TestClock.adjust("1 minute");
      const admitted = yield* Deferred.make<ArtifactSchedule>();
      const finish = yield* Deferred.make<void>();
      const running = yield* runArtifactSchedulePass((schedule) =>
        Deferred.succeed(admitted, schedule).pipe(Effect.andThen(Deferred.await(finish))),
      ).pipe(Effect.provide(f.context), Effect.forkChild);
      const captured = yield* Deferred.await(admitted);
      yield* configureArtifactSchedule(
        input({ handler: "new-handler", input: { city: "NYC" } }),
      ).pipe(Effect.provide(f.context));
      expect(captured.handler).toBe("refresh");
      expect(captured.input).toEqual({ city: "Boston" });
      expect(f.records.snapshot().artifactSchedules[0]?.handler).toBe("new-handler");
      yield* Deferred.succeed(finish, undefined);
      yield* Fiber.join(running);
    }),
  );

  it.effect(
    "removes all artifact schedules before data deletion and preserves other artifacts",
    () =>
      Effect.gen(function* () {
        const f = yield* setup();
        yield* Effect.gen(function* () {
          yield* configureArtifactSchedule(input());
          yield* configureArtifactSchedule(input({ name: "second" }));
          yield* configureArtifactSchedule(input({ lineageId: otherId }));
          yield* removeArtifactSchedules(lineageId);
          expect(yield* listArtifactSchedules(lineageId)).toEqual([]);
          expect((yield* Ref.get(f.persisted)).artifactSchedules).toHaveLength(1);
          yield* TestClock.adjust("1 minute");
          const calls = yield* Ref.make<ReadonlyArray<string>>([]);
          yield* runArtifactSchedulePass((schedule) =>
            Ref.update(calls, (all) => [...all, schedule.lineageId]),
          );
          expect(yield* Ref.get(calls)).toEqual([otherId]);
        }).pipe(Effect.provide(f.context));
      }),
  );

  it.effect("fires one-time schedules once and isolates handler failure from other schedules", () =>
    Effect.gen(function* () {
      const f = yield* setup();
      yield* Effect.gen(function* () {
        yield* configureArtifactSchedule(
          input({ schedule: { _tag: "Once", at: "2030-01-01T00:01:00.000Z" } }),
        );
        yield* configureArtifactSchedule(input({ lineageId: otherId }));
        yield* TestClock.adjust("1 minute");
        const calls = yield* Ref.make<ReadonlyArray<string>>([]);
        const invoke = (schedule: ArtifactSchedule) =>
          Ref.update(calls, (all) => [...all, schedule.lineageId]).pipe(
            Effect.andThen(
              schedule.lineageId === lineageId ? Effect.fail("handler failed") : Effect.void,
            ),
          );
        yield* runArtifactSchedulePass(invoke);
        yield* runArtifactSchedulePass(invoke);
        expect(yield* Ref.get(calls)).toEqual([lineageId, otherId]);
        expect(f.records.snapshot().artifactSchedules[0]?.nextScheduledAt).toBeUndefined();
        expect(f.records.snapshot().artifactSchedules[0]?.lastOutcome).toBe("failed");
        expect(f.records.snapshot().artifactSchedules[0]?.lastError).toBe("handler failed");
        expect(f.records.snapshot().artifactSchedules[1]?.lastOutcome).toBe("completed");
        yield* configureArtifactSchedule(input());
        expect(
          f.records.snapshot().artifactSchedules.find((item) => item.lineageId === lineageId)
            ?.lastError,
        ).toBe("handler failed");
        yield* TestClock.adjust("1 minute");
        yield* runArtifactSchedulePass(() => Effect.void);
        const recovered = f.records
          .snapshot()
          .artifactSchedules.find((item) => item.lineageId === lineageId);
        expect(recovered?.lastOutcome).toBe("completed");
        expect(recovered?.lastError).toBeUndefined();
      }).pipe(Effect.provide(f.context));
    }),
  );

  it.effect(
    "keeps an unadmitted due Once occurrence when an earlier handler pauses it, then runs it once on resume",
    () =>
      Effect.gen(function* () {
        const f = yield* setup();
        yield* Effect.gen(function* () {
          const once = { _tag: "Once" as const, at: "2030-01-01T00:01:00.000Z" };
          yield* configureArtifactSchedule(input({ schedule: once }));
          yield* configureArtifactSchedule(input({ lineageId: otherId, schedule: once }));
          yield* TestClock.adjust("1 minute");
          const calls: string[] = [];
          const invoke = Effect.fn("ArtifactScheduleTest.pauseLater")(function* (
            schedule: ArtifactSchedule,
          ) {
            calls.push(schedule.lineageId);
            if (schedule.lineageId === lineageId) yield* setArtifactSchedulesPaused(otherId, true);
          });
          yield* runArtifactSchedulePass(invoke);
          expect(calls).toEqual([lineageId]);
          expect((yield* listArtifactSchedules(otherId))[0]).toMatchObject({
            paused: true,
            nextScheduledAt: once.at,
          });
          expect((yield* listArtifactSchedules(otherId))[0]?.lastRunAt).toBeUndefined();
          yield* setArtifactSchedulesPaused(otherId, false);
          yield* runArtifactSchedulePass(invoke);
          yield* runArtifactSchedulePass(invoke);
          expect(calls).toEqual([lineageId, otherId]);
          expect((yield* listArtifactSchedules(otherId))[0]?.nextScheduledAt).toBeUndefined();
          expect((yield* listArtifactSchedules(otherId))[0]?.lastOutcome).toBe("completed");
        }).pipe(Effect.provide(f.context));
      }),
  );

  it.effect("rejects invalid configuration before saving", () =>
    Effect.gen(function* () {
      const f = yield* setup();
      yield* Effect.gen(function* () {
        const past = yield* configureArtifactSchedule(
          input({ schedule: { _tag: "Once", at: "2029-01-01T00:00:00.000Z" } }),
        ).pipe(Effect.result);
        const invalidCron = yield* configureArtifactSchedule(
          input({
            schedule: {
              _tag: "Calendar",
              expression: "invalid",
              timeZone: "UTC",
              startsAt: "2030-01-01T00:00:00.000Z",
            },
          }),
        ).pipe(Effect.result);
        const blank = yield* configureArtifactSchedule(input({ handler: "" })).pipe(Effect.result);
        expect(past._tag).toBe("Failure");
        expect(invalidCron._tag).toBe("Failure");
        expect(blank._tag).toBe("Failure");
        expect(yield* listArtifactSchedules()).toEqual([]);
      }).pipe(Effect.provide(f.context));
    }),
  );

  it.effect("migrates v1 ledgers and durably round-trips v2 schedule state", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.acquireRelease(
        Effect.promise(() => mkdtemp(join(tmpdir(), "cake-artifact-schedules-"))),
        (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
      );
      const document = join(directory, "automations.json");
      yield* Effect.promise(() =>
        writeFile(
          document,
          JSON.stringify({ version: 1, data: { automations: [], occurrences: [], runs: [] } }),
        ),
      );
      const storage = makeAutomationStorageLive(directory).pipe(
        Layer.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer)),
      );
      yield* Effect.gen(function* () {
        const records = yield* AutomationRecords;
        yield* records.initialize();
        expect(records.snapshot().artifactSchedules).toEqual([]);
        yield* TestClock.setTime(new Date("2030-01-01T00:00:00.000Z").getTime());
        yield* configureArtifactSchedule(input());
        yield* setArtifactSchedulesPaused(lineageId, true);
      }).pipe(
        Effect.provide(
          Layer.merge(AutomationRecords.layer.pipe(Layer.provide(storage)), ClientEventsLive),
        ),
      );
      const stored = yield* Effect.promise(() => readFile(document, "utf8"));
      expect(JSON.parse(stored).version).toBe(2);
      const restored = yield* Effect.gen(function* () {
        const records = yield* AutomationRecords;
        yield* records.initialize();
        return records.snapshot().artifactSchedules;
      }).pipe(Effect.provide(Layer.fresh(AutomationRecords.layer.pipe(Layer.provide(storage)))));
      expect(restored).toHaveLength(1);
      expect(restored[0]?.paused).toBe(true);
      expect(restored[0]?.nextScheduledAt).toBe("2030-01-01T00:01:00.000Z");
    }),
  );
});
