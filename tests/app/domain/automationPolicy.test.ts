import { describe, expect } from "vitest";
import { it } from "@effect/vitest";
import { Effect, Queue, Stream } from "effect";
import { decideAdmission, matchesEvent } from "../../../src/domain/automations/automationPolicy";
import type {
  AutomationEventFilter,
  AutomationSourceEvent,
} from "../../../src/contracts/automations/automation-data";
import * as definitions from "../../../src/domain/automations/automationDefinitions";
import * as runs from "../../../src/domain/automations/automationRuns";
import { automationDefinition, automationFixture } from "../helpers/automationFixture";

const filter: AutomationEventFilter = {
  event: "assistant-response-completed",
  scope: { _tag: "Project", projectPath: "/projects/cake" },
  sessionKinds: ["family-root"],
  sessionId: "root",
  contentContains: "ready",
};
const event: AutomationSourceEvent = {
  eventId: "event-1",
  event: "assistant-response-completed",
  occurredAt: "2030-01-01T09:00:00.000Z",
  sourceSessionId: "root",
  sourceKind: "family-root",
  projectPath: "/projects/cake",
  sourceMessageId: "final",
  text: "The review is ready.",
};

const finish = (f: Effect.Success<ReturnType<typeof automationFixture>>, sessionId: string) =>
  f.complete(sessionId).pipe(
    Effect.andThen(
      f.records.changes().pipe(
        Stream.filter((ledger) =>
          ledger.runs.some((run) => run.sessionId === sessionId && run.status._tag !== "running"),
        ),
        Stream.take(1),
        Stream.runDrain,
      ),
    ),
  );

describe("automation admission", () => {
  it.effect("starts an active idle automation and records its trigger occurrence", () =>
    Effect.gen(function* () {
      const f = yield* automationFixture();
      yield* Effect.gen(function* () {
        const a = yield* definitions.create({
          definition: automationDefinition(),
          initialState: "active",
        });
        const result = yield* runs.trigger(a.id);
        expect(result._tag).toBe("started");
        expect(f.records.snapshot().occurrences[0]?.id).toBe(result.occurrenceId);
        yield* finish(f, (yield* Queue.take(f.started)).sessionId);
      }).pipe(Effect.provide(f.context));
    }),
  );
  it.effect("skips a busy automation without replay when overlap is skip", () =>
    Effect.gen(function* () {
      const f = yield* automationFixture();
      yield* Effect.gen(function* () {
        const a = yield* definitions.create({
          definition: automationDefinition(),
          initialState: "active",
        });
        yield* runs.trigger(a.id);
        const first = yield* Queue.take(f.started);
        expect((yield* runs.trigger(a.id))._tag).toBe("skipped");
        yield* finish(f, first.sessionId);
        expect(f.records.snapshot().runs).toHaveLength(1);
        expect(
          f.records.snapshot().occurrences.filter((item) => item.disposition._tag === "queued"),
        ).toHaveLength(0);
      }).pipe(Effect.provide(f.context));
    }),
  );
  it.effect("queues busy occurrences FIFO without creating Pi sessions before execution", () =>
    Effect.gen(function* () {
      const f = yield* automationFixture();
      yield* Effect.gen(function* () {
        const a = yield* definitions.create({
          definition: automationDefinition({ overlap: "queue" }),
          initialState: "active",
        });
        yield* runs.trigger(a.id);
        const first = yield* Queue.take(f.started);
        const second = yield* runs.trigger(a.id);
        const third = yield* runs.trigger(a.id);
        expect(f.captured).toHaveLength(1);
        yield* finish(f, first.sessionId);
        const secondSession = yield* Queue.take(f.started);
        expect(f.records.snapshot().runs[1]?.occurrenceId).toBe(second.occurrenceId);
        yield* finish(f, secondSession.sessionId);
        const thirdSession = yield* Queue.take(f.started);
        expect(f.records.snapshot().runs[2]?.occurrenceId).toBe(third.occurrenceId);
        yield* finish(f, thirdSession.sessionId);
      }).pipe(Effect.provide(f.context));
    }),
  );
  it.effect("starts parallel sessions only for the same automation's parallel policy", () =>
    Effect.gen(function* () {
      const f = yield* automationFixture();
      yield* Effect.gen(function* () {
        const a = yield* definitions.create({
          definition: automationDefinition({ overlap: "parallel" }),
          initialState: "active",
        });
        expect((yield* runs.trigger(a.id))._tag).toBe("started");
        expect((yield* runs.trigger(a.id))._tag).toBe("started");
        expect(
          f.records.snapshot().runs.filter((run) => run.status._tag === "running"),
        ).toHaveLength(2);
        yield* finish(f, (yield* Queue.take(f.started)).sessionId);
        yield* finish(f, (yield* Queue.take(f.started)).sessionId);
      }).pipe(Effect.provide(f.context));
    }),
  );
  it.effect("does not let another automation's activity block admission", () =>
    Effect.gen(function* () {
      const f = yield* automationFixture();
      yield* Effect.gen(function* () {
        const a = yield* definitions.create({
          definition: automationDefinition(),
          initialState: "active",
        });
        const b = yield* definitions.create({
          definition: automationDefinition(),
          initialState: "active",
        });
        expect((yield* runs.trigger(a.id))._tag).toBe("started");
        expect((yield* runs.trigger(b.id))._tag).toBe("started");
        yield* finish(f, (yield* Queue.take(f.started)).sessionId);
        yield* finish(f, (yield* Queue.take(f.started)).sessionId);
      }).pipe(Effect.provide(f.context));
    }),
  );
  it("skips automatic triggers while paused without building a missed-trigger backlog", () => {
    for (const source of ["schedule", "event"] as const)
      expect(
        decideAdmission({ state: { _tag: "paused" }, overlap: "queue", runningSessions: 1, source })
          .action,
      ).toBe("skip");
  });
  it("allows manual Run now while paused without activating the automation", () => {
    const state = { _tag: "paused" as const };
    expect(
      decideAdmission({ state, overlap: "skip", runningSessions: 0, source: "manual" }).action,
    ).toBe("start");
    expect(state._tag).toBe("paused");
  });
  it("applies overlap to manual Run now as well as automatic triggers", () => {
    for (const source of ["manual", "schedule", "event"] as const) {
      expect(
        decideAdmission({ state: { _tag: "active" }, overlap: "skip", runningSessions: 1, source })
          .action,
      ).toBe("skip");
      expect(
        decideAdmission({ state: { _tag: "active" }, overlap: "queue", runningSessions: 1, source })
          .action,
      ).toBe("queue");
      expect(
        decideAdmission({
          state: { _tag: "active" },
          overlap: "parallel",
          runningSessions: 1,
          source,
        }).action,
      ).toBe("start");
    }
  });
  it("blocks execution while suspended or archived with a concrete reason", () => {
    const suspended = decideAdmission({
      state: { _tag: "suspended", reason: "Project is missing." },
      overlap: "parallel",
      runningSessions: 0,
      source: "manual",
    });
    expect(suspended).toEqual({ action: "block", reason: "Project is missing." });
    expect(
      decideAdmission({
        state: { _tag: "archived" },
        overlap: "parallel",
        runningSessions: 0,
        source: "manual",
      }).action,
    ).toBe("block");
  });
  it.effect("admits at most one session when simultaneous triggers use skip or queue", () =>
    Effect.gen(function* () {
      const f = yield* automationFixture();
      yield* Effect.gen(function* () {
        for (const overlap of ["skip", "queue"] as const) {
          const a = yield* definitions.create({
            definition: automationDefinition({ overlap }),
            initialState: "active",
          });
          const results = yield* Effect.all([runs.trigger(a.id), runs.trigger(a.id)], {
            concurrency: "unbounded",
          });
          expect(results.filter((result) => result._tag === "started")).toHaveLength(1);
          expect(f.records.snapshot().runs.filter((run) => run.automationId === a.id)).toHaveLength(
            1,
          );
          if (overlap === "queue") {
            const queued = results.find((result) => result._tag === "queued");
            expect(queued).toBeDefined();
            if (queued) yield* runs.cancelQueued(queued.occurrenceId);
          }
          yield* finish(f, (yield* Queue.take(f.started)).sessionId);
        }
      }).pipe(Effect.provide(f.context));
    }),
  );
});

describe("scoped event matching", () => {
  it("matches the configured event, project, source kind, exact session and content together", () => {
    expect(matchesEvent(filter, event)).toBe(true);
    expect(matchesEvent(filter, { ...event, event: "user-message-received" })).toBe(false);
    expect(matchesEvent(filter, { ...event, text: "Not yet." })).toBe(false);
  });
  it("distinguishes standalone sessions, family roots, and recursive family children", () => {
    for (const sourceKind of ["standalone-project-session", "family-root", "family-child"] as const)
      expect(matchesEvent(filter, { ...event, sourceKind })).toBe(sourceKind === "family-root");
    expect(
      matchesEvent(
        { ...filter, sessionKinds: ["family-child"] },
        { ...event, sourceKind: "family-child" },
      ),
    ).toBe(true);
  });
  it("distinguishes permanent global Cake Chat from a Project Chat", () => {
    const global: AutomationEventFilter = {
      event: "assistant-response-completed",
      scope: { _tag: "Global" },
      sessionKinds: ["cake-chat"],
    };
    expect(
      matchesEvent(global, {
        eventId: "global",
        event: event.event,
        occurredAt: event.occurredAt,
        sourceSessionId: "cake-chat",
        sourceKind: "cake-chat",
      }),
    ).toBe(true);
    expect(matchesEvent(global, { ...event, sourceKind: "project-chat" })).toBe(false);
  });
  it("does not infer family roots from a missing parent or from creator provenance", () => {
    // The matcher accepts a resolved source kind; absent ancestry never promotes a standalone source.
    expect(matchesEvent(filter, { ...event, sourceKind: "standalone-project-session" })).toBe(
      false,
    );
  });
  it("does not match an otherwise identical event from another project or session", () => {
    expect(matchesEvent(filter, { ...event, projectPath: "/projects/orchard" })).toBe(false);
    expect(matchesEvent(filter, { ...event, sourceSessionId: "another-root" })).toBe(false);
  });
  it("does not match content filters against session-created events with no message", () => {
    const { text: _text, ...withoutText } = event;
    void _text;
    expect(
      matchesEvent(
        { ...filter, event: "session-created" },
        { ...withoutText, event: "session-created" },
      ),
    ).toBe(false);
  });
});
