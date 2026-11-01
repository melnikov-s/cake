import { describe, expect } from "vitest";
import { it } from "@effect/vitest";
import { DateTime, Effect, Queue, Ref, Stream } from "effect";
import { TestClock } from "effect/testing";
import type { AutomationSchedule } from "../../../src/contracts/automations/automation-data";
import * as worker from "../../../src/domain/automations/automationWorker";
import { automationDefinition, automationFixture } from "../helpers/automationFixture";
import * as definitions from "../../../src/domain/automations/automationDefinitions";
import * as runs from "../../../src/domain/automations/automationRuns";

const waitForSettlement = (
  f: Effect.Success<ReturnType<typeof automationFixture>>,
  sessionId: string,
) =>
  f.records.changes().pipe(
    Stream.filter((ledger) =>
      ledger.runs.some((run) => run.sessionId === sessionId && run.status._tag !== "running"),
    ),
    Stream.take(1),
    Stream.runDrain,
  );

describe("automation lifecycle and execution", () => {
  it.effect(
    "creates a definition with an independent memory identity and explicit execution settings",
    () =>
      Effect.gen(function* () {
        const f = yield* automationFixture();
        const a = yield* definitions
          .create({ definition: automationDefinition(), initialState: "active" })
          .pipe(Effect.provide(f.context));
        const b = yield* definitions
          .create({ definition: automationDefinition(), initialState: "paused" })
          .pipe(Effect.provide(f.context));
        expect(a.memoryId).not.toBe(b.memoryId);
        expect(a.definition).toEqual(automationDefinition());
        expect(b.state._tag).toBe("paused");
        expect((yield* Ref.get(f.persisted)).automations).toHaveLength(2);
      }),
  );
  it.effect(
    "starts a real AutomationSession identity from a manual trigger without a fake project",
    () =>
      Effect.gen(function* () {
        const f = yield* automationFixture();
        yield* Effect.gen(function* () {
          const automation = yield* definitions.create({
            definition: automationDefinition(),
            initialState: "active",
          });
          const result = yield* runs.trigger(automation.id);
          expect(result._tag).toBe("started");
          if (result._tag !== "started") return;
          const started = yield* Queue.take(f.started);
          expect(started.sessionId).toBe(result.sessionId);
          expect(started.options.cwd).toBe("/home/user");
          const handle = yield* f.sessions.acquireSession(result.sessionId);
          expect(handle.profile).toBe("AutomationSession");
          const run = yield* runs.lookupRun(result.runId);
          expect(run.context).toEqual({ _tag: "Global" });
          expect(f.records.snapshot().occurrences[0]?.disposition._tag).toBe("started");
          yield* f.complete(result.sessionId);
          yield* waitForSettlement(f, result.sessionId);
        }).pipe(Effect.provide(f.context));
      }),
  );
  it.effect(
    "loads global resources at home and project resources at the selected trusted project root",
    () =>
      Effect.gen(function* () {
        const f = yield* automationFixture();
        yield* Effect.gen(function* () {
          const automation = yield* definitions.create({
            definition: automationDefinition({
              context: { _tag: "Project", projectPath: "/projects/cake" },
            }),
            initialState: "active",
          });
          const result = yield* runs.trigger(automation.id);
          expect(result._tag).toBe("started");
          const started = yield* Queue.take(f.started);
          expect(started.options.cwd).toBe("/projects/cake");
          expect(started.options.trusted).toBe(true);
          expect(started.options.isolatedSystemPrompt).toBeUndefined();
          expect(started.options.agentDir).toBe("/agent");
          yield* f.complete(started.sessionId);
          yield* waitForSettlement(f, started.sessionId);
        }).pipe(Effect.provide(f.context));
      }),
  );
  it.effect(
    "does not create a worktree or session family merely by starting an automation run",
    () =>
      Effect.gen(function* () {
        const f = yield* automationFixture();
        yield* Effect.gen(function* () {
          const automation = yield* definitions.create({
            definition: automationDefinition(),
            initialState: "active",
          });
          yield* runs.trigger(automation.id);
          const started = yield* Queue.take(f.started);
          expect(started.options.worktreeLanding).toBeUndefined();
          expect(started.options.currentSessionControl?.createChildSession).toBeUndefined();
          expect(started.options.sessionDir).toContain(`/automations/${automation.id}`);
          yield* f.complete(started.sessionId);
          yield* waitForSettlement(f, started.sessionId);
        }).pipe(Effect.provide(f.context));
      }),
  );
  it.effect(
    "keeps configuration edits out of running sessions and already accepted queued work",
    () =>
      Effect.gen(function* () {
        const f = yield* automationFixture();
        yield* Effect.gen(function* () {
          const original = automationDefinition({ overlap: "queue" });
          const automation = yield* definitions.create({
            definition: original,
            initialState: "active",
          });
          yield* runs.trigger(automation.id);
          const first = yield* Queue.take(f.started);
          expect((yield* runs.trigger(automation.id))._tag).toBe("queued");
          yield* definitions.update({
            automationId: automation.id,
            definition: { ...original, task: { ...original.task, prompt: "A different task" } },
          });
          yield* f.complete(first.sessionId);
          const second = yield* Queue.take(f.started);
          expect(second.text).toBe(original.task.prompt);
          expect(first.text).toBe(original.task.prompt);
          yield* f.complete(second.sessionId);
          yield* waitForSettlement(f, second.sessionId);
        }).pipe(Effect.provide(f.context));
      }),
  );
  it.effect(
    "pauses new automatic admission, lets active sessions finish, and holds existing queued work",
    () =>
      Effect.gen(function* () {
        const f = yield* automationFixture();
        yield* Effect.gen(function* () {
          const automation = yield* definitions.create({
            definition: automationDefinition({ overlap: "queue" }),
            initialState: "active",
          });
          yield* runs.trigger(automation.id);
          const first = yield* Queue.take(f.started);
          yield* runs.trigger(automation.id);
          yield* definitions.changeState(automation.id, { _tag: "paused" });
          expect(
            (yield* runs.trigger(automation.id, {
              _tag: "Schedule",
              scheduledAt: "2030-01-01T09:00:00.000Z",
            }))._tag,
          ).toBe("skipped");
          expect(f.records.snapshot().runs[0]?.status._tag).toBe("running");
          yield* f.complete(first.sessionId);
          yield* waitForSettlement(f, first.sessionId);
          expect(
            f.records.snapshot().occurrences.filter((item) => item.disposition._tag === "queued"),
          ).toHaveLength(1);
          expect(f.captured).toHaveLength(1);
        }).pipe(Effect.provide(f.context));
      }),
  );
  it.effect(
    "resumes queued occurrences FIFO after activation without replaying skipped triggers",
    () =>
      Effect.gen(function* () {
        const f = yield* automationFixture();
        yield* Effect.gen(function* () {
          const automation = yield* definitions.create({
            definition: automationDefinition({ overlap: "queue" }),
            initialState: "active",
          });
          yield* runs.trigger(automation.id);
          const first = yield* Queue.take(f.started);
          const queued = yield* runs.trigger(automation.id);
          yield* definitions.changeState(automation.id, { _tag: "paused" });
          yield* f.complete(first.sessionId);
          yield* waitForSettlement(f, first.sessionId);
          yield* runs.activate(automation.id);
          const second = yield* Queue.take(f.started);
          expect(f.records.snapshot().runs[1]?.occurrenceId).toBe(queued.occurrenceId);
          yield* f.complete(second.sessionId);
          yield* waitForSettlement(f, second.sessionId);
          expect(f.captured).toHaveLength(2);
        }).pipe(Effect.provide(f.context));
      }),
  );
  it.effect(
    "archives future triggers and cancels queued work while honoring let-finish versus stop",
    () =>
      Effect.gen(function* () {
        const f = yield* automationFixture();
        yield* Effect.gen(function* () {
          for (const runningSessions of ["let-finish", "stop"] as const) {
            const a = yield* definitions.create({
              definition: automationDefinition({ overlap: "queue" }),
              initialState: "active",
            });
            yield* runs.trigger(a.id);
            const started = yield* Queue.take(f.started);
            yield* runs.trigger(a.id);
            yield* runs.archive({ automationId: a.id, runningSessions });
            expect(
              f.records
                .snapshot()
                .occurrences.filter(
                  (item) => item.automationId === a.id && item.disposition._tag === "canceled",
                ),
            ).toHaveLength(1);
            if (runningSessions === "let-finish") {
              expect((yield* runs.runForSession(started.sessionId)).status._tag).toBe("running");
              yield* f.complete(started.sessionId);
            }
            yield* waitForSettlement(f, started.sessionId);
            expect((yield* definitions.lookup(a.id)).state._tag).toBe("archived");
            expect((yield* runs.trigger(a.id))._tag).toBe("blocked");
          }
        }).pipe(Effect.provide(f.context));
      }),
  );
  it.effect("keeps a single failed run visible without suspending the entire automation", () =>
    Effect.gen(function* () {
      const f = yield* automationFixture();
      yield* Effect.gen(function* () {
        const a = yield* definitions.create({
          definition: automationDefinition({ completion: "auto-resolve" }),
          initialState: "active",
        });
        yield* runs.trigger(a.id);
        const started = yield* Queue.take(f.started);
        yield* f.fail(started.sessionId);
        yield* waitForSettlement(f, started.sessionId);
        expect((yield* definitions.lookup(a.id)).state._tag).toBe("active");
        expect((yield* runs.runForSession(started.sessionId)).status._tag).toBe("failed");
        expect((yield* Ref.get(f.resolved)).has(started.sessionId)).toBe(false);
      }).pipe(Effect.provide(f.context));
    }),
  );
  it.effect(
    "suspends an unavailable project automation with a reason and validates before activation",
    () =>
      Effect.gen(function* () {
        const f = yield* automationFixture();
        yield* Effect.gen(function* () {
          const a = yield* definitions.create({
            definition: automationDefinition({
              context: { _tag: "Project", projectPath: "/projects/cake" },
            }),
            initialState: "active",
          });
          f.setProjectAvailable(false);
          const result = yield* runs.trigger(a.id);
          expect(result._tag).toBe("blocked");
          const state = (yield* definitions.lookup(a.id)).state;
          expect(state._tag).toBe("suspended");
          if (state._tag === "suspended") expect(state.reason).toContain("missing");
          expect((yield* runs.activate(a.id).pipe(Effect.result))._tag).toBe("Failure");
          f.setProjectAvailable(true);
          yield* runs.activate(a.id);
          expect((yield* definitions.lookup(a.id)).state._tag).toBe("active");
        }).pipe(Effect.provide(f.context));
      }),
  );
  it.effect(
    "archives a one-time automation after its execution attempt and retains memory and history",
    () =>
      Effect.gen(function* () {
        const f = yield* automationFixture();
        yield* Effect.gen(function* () {
          const a = yield* definitions.create({
            definition: automationDefinition({
              trigger: {
                _tag: "Schedule",
                schedule: { _tag: "Once", at: "2030-01-01T09:00:00.000Z" },
              },
            }),
            initialState: "active",
          });
          yield* TestClock.setTime(
            DateTime.toEpochMillis(DateTime.makeUnsafe("2030-01-01T09:00:00.000Z")),
          );
          yield* worker.runSchedulePass();
          const started = yield* Queue.take(f.started);
          yield* f.complete(started.sessionId);
          yield* waitForSettlement(f, started.sessionId);
          expect((yield* definitions.lookup(a.id)).state._tag).toBe("archived");
          expect((yield* definitions.lookup(a.id)).memoryId).toBe(a.memoryId);
          expect((yield* definitions.history({ automationId: a.id })).runs[0]?.sessionId).toBe(
            started.sessionId,
          );
        }).pipe(Effect.provide(f.context));
      }),
  );
  it.effect(
    "auto-resolves successful sessions only when configured and retains failures for review",
    () =>
      Effect.gen(function* () {
        const f = yield* automationFixture();
        yield* Effect.gen(function* () {
          const automation = yield* definitions.create({
            definition: automationDefinition({ completion: "auto-resolve" }),
            initialState: "active",
          });
          yield* runs.trigger(automation.id);
          const started = yield* Queue.take(f.started);
          yield* f.complete(started.sessionId);
          yield* f.records.changes().pipe(
            Stream.mapEffect(() => Ref.get(f.resolved)),
            Stream.filter((ids) => ids.has(started.sessionId)),
            Stream.take(1),
            Stream.runDrain,
          );
          expect((yield* runs.runForSession(started.sessionId)).status._tag).toBe("completed");
          yield* runs.trigger(automation.id);
          const failed = yield* Queue.take(f.started);
          yield* f.fail(failed.sessionId);
          yield* waitForSettlement(f, failed.sessionId);
          expect((yield* Ref.get(f.resolved)).has(failed.sessionId)).toBe(false);
        }).pipe(Effect.provide(f.context));
      }),
  );
  it.effect("lets keep-for-review sessions remain unresolved after successful execution", () =>
    Effect.gen(function* () {
      const f = yield* automationFixture();
      yield* Effect.gen(function* () {
        const automation = yield* definitions.create({
          definition: automationDefinition(),
          initialState: "active",
        });
        yield* runs.trigger(automation.id);
        const started = yield* Queue.take(f.started);
        yield* f.complete(started.sessionId);
        yield* waitForSettlement(f, started.sessionId);
        expect((yield* Ref.get(f.resolved)).has(started.sessionId)).toBe(false);
      }).pipe(Effect.provide(f.context));
    }),
  );
  it.effect(
    "unresolves a historical session without rerunning or reactivating its automation",
    () =>
      Effect.gen(function* () {
        const f = yield* automationFixture();
        yield* Effect.gen(function* () {
          const automation = yield* definitions.create({
            definition: automationDefinition(),
            initialState: "active",
          });
          yield* runs.trigger(automation.id);
          const started = yield* Queue.take(f.started);
          yield* f.complete(started.sessionId);
          yield* waitForSettlement(f, started.sessionId);
          yield* definitions.changeState(automation.id, { _tag: "paused" });
          yield* runs.setResolved(started.sessionId, true);
          yield* runs.setResolved(started.sessionId, false);
          expect(f.captured).toHaveLength(1);
          expect((yield* definitions.lookup(automation.id)).state._tag).toBe("paused");
          expect((yield* Ref.get(f.resolved)).has(started.sessionId)).toBe(false);
        }).pipe(Effect.provide(f.context));
      }),
  );
  it.effect(
    "cancels a run without pausing its automation and cancels queued work without creating a session",
    () =>
      Effect.gen(function* () {
        const f = yield* automationFixture();
        yield* Effect.gen(function* () {
          const a = yield* definitions.create({
            definition: automationDefinition({ overlap: "queue" }),
            initialState: "active",
          });
          const first = yield* runs.trigger(a.id);
          const started = yield* Queue.take(f.started);
          const queued = yield* runs.trigger(a.id);
          yield* runs.cancelQueued(queued.occurrenceId);
          if (first._tag === "started") yield* runs.cancelRun(first.runId);
          yield* waitForSettlement(f, started.sessionId);
          expect((yield* definitions.lookup(a.id)).state._tag).toBe("active");
          expect((yield* runs.runForSession(started.sessionId)).status._tag).toBe("canceled");
          expect(f.captured).toHaveLength(1);
        }).pipe(Effect.provide(f.context));
      }),
  );
});

describe("automation triggers and recovery", () => {
  it.effect(
    "fires once, fixed-interval, and timezone-aware calendar schedules using backend time",
    () =>
      Effect.gen(function* () {
        const f = yield* automationFixture();
        yield* Effect.gen(function* () {
          const schedules: AutomationSchedule[] = [
            { _tag: "Once", at: "2030-01-01T09:00:00.000Z" },
            { _tag: "Interval", startsAt: "2030-01-01T09:00:00.000Z", everySeconds: 86_400 },
            {
              _tag: "Calendar",
              expression: "0 9 * * *",
              timeZone: "America/New_York",
              startsAt: "2030-01-01T09:00:00.000Z",
            },
          ];
          for (const schedule of schedules)
            yield* definitions.create({
              definition: automationDefinition({ trigger: { _tag: "Schedule", schedule } }),
              initialState: "active",
            });
          expect(f.records.snapshot().automations[2]?.nextScheduledAt).toBe(
            "2030-01-01T14:00:00.000Z",
          );
          yield* worker.runSchedulePass();
          expect(f.captured).toHaveLength(0);
          yield* TestClock.setTime(
            DateTime.toEpochMillis(DateTime.makeUnsafe("2030-01-01T14:00:00.000Z")),
          );
          yield* worker.runSchedulePass();
          expect(f.captured).toHaveLength(3);
          yield* worker.runSchedulePass();
          expect(f.captured).toHaveLength(3);
          for (let i = 0; i < 3; i++) {
            const started = yield* Queue.take(f.started);
            yield* f.complete(started.sessionId);
            yield* waitForSettlement(f, started.sessionId);
          }
          expect(f.records.snapshot().automations[0]?.state._tag).toBe("archived");
        }).pipe(Effect.provide(f.context));
      }),
  );
  it.effect("does not backfill every missed interval when the backend restarts", () =>
    Effect.gen(function* () {
      const f = yield* automationFixture();
      yield* Effect.gen(function* () {
        yield* definitions.create({ definition: automationDefinition(), initialState: "active" });
        yield* TestClock.setTime(
          DateTime.toEpochMillis(DateTime.makeUnsafe("2030-01-11T09:00:00.000Z")),
        );
        yield* worker.runSchedulePass();
        yield* worker.runSchedulePass();
        expect(f.captured).toHaveLength(1);
        expect(f.records.snapshot().automations[0]?.nextScheduledAt).toBe(
          "2030-01-12T09:00:00.000Z",
        );
        const started = yield* Queue.take(f.started);
        yield* f.complete(started.sessionId);
        yield* waitForSettlement(f, started.sessionId);
      }).pipe(Effect.provide(f.context));
    }),
  );
  it.todo("persists definitions, queued occurrences and session links across restart");
  it.todo("uses existing Pi recovery outcomes rather than blindly rerunning interrupted work");
  it.todo(
    "emits response-completed only for a successful final reply, never tools or intermediate text",
  );
  it.todo("emits user-message-received only for genuine user input, not internal notices");
  it.effect(
    "evaluates source events without requiring a renderer to observe the source session",
    () =>
      Effect.gen(function* () {
        const f = yield* automationFixture();
        yield* Effect.gen(function* () {
          yield* definitions.create({
            definition: automationDefinition({
              trigger: {
                _tag: "Event",
                filter: {
                  event: "assistant-response-completed",
                  scope: { _tag: "Project", projectPath: "/projects/cake" },
                  sessionKinds: ["family-child"],
                  sessionId: "child",
                  contentContains: "ready",
                },
              },
            }),
            initialState: "active",
          });
          const event = {
            eventId: "event",
            event: "assistant-response-completed" as const,
            occurredAt: "2030-01-01T09:00:00.000Z",
            projectPath: "/projects/cake",
            sourceSessionId: "child",
            sourceKind: "family-child" as const,
            sourceMessageId: "final",
            text: "ready",
          };
          yield* worker.acceptEvent({ ...event, sourceSessionId: "unrelated" });
          expect(f.captured).toHaveLength(0);
          yield* worker.acceptEvent(event);
          const started = yield* Queue.take(f.started);
          expect(f.records.snapshot().occurrences[0]?.source._tag).toBe("Event");
          yield* f.complete(started.sessionId);
          yield* waitForSettlement(f, started.sessionId);
        }).pipe(Effect.provide(f.context));
      }),
  );
});
