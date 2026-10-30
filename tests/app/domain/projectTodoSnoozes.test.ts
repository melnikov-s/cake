import { it } from "@effect/vitest";
import { expect } from "vitest";
import { Deferred, Effect, Fiber, Layer, Schema } from "effect";
import { makeSubagentStorageTestLayer } from "../helpers/subagentStorageFixture";
import { TestClock } from "effect/testing";
import {
  ApplicationState as StateSchema,
  defaultApplicationState,
} from "../../../src/contracts/application/application-data";
import {
  CAKE_CHAT_TODO_SCOPE,
  type ProjectTodo,
  ProjectTodoSnooze,
  projectTodoBaseline,
} from "../../../src/contracts/projects/project-todos";
import { ApplicationState } from "../../../src/services/storage/ApplicationState";
import { ApplicationStorage } from "../../../src/services/storage/ApplicationStorage";
import { ApplicationWriteError } from "../../../src/contracts/storage/application-storage-errors";
import { CakeSessionRuntimes } from "../../../src/services/pi/CakeSessionRuntimes";
import { SessionArchiveStorage } from "../../../src/services/storage/SessionArchiveStorage";
import { SessionFamilyStorage } from "../../../src/services/storage/SessionFamilyStorage";
import { ProjectSessionConfiguration } from "../../../src/services/project-sessions/ProjectSessionConfiguration";
import { ManagedWorktrees } from "../../../src/services/worktrees/ManagedWorktrees";
import { upsertProject } from "../../../src/domain/application/application";
import * as todos from "../../../src/domain/projects/projectTodos";
import * as controls from "../../../src/domain/projects/projectTodoAssociations";
import * as snoozes from "../../../src/domain/projects/projectTodoSnoozes";
import { createProjectTodoOperations } from "../../../src/domain/projects/project-todo-operations";
import { CakeOperationRegistry } from "../../../src/services/pi/runtime/cake-operation-registry";

const project = "/project";
const until = "1970-01-01T00:15:00.000Z";
const later = "1970-01-01T01:00:00.000Z";
const create = (scope = project) =>
  todos.create(scope, { title: "Review findings", description: "Awaiting review." });
const snooze = (item: ProjectTodo, scope = project, deadline = until) =>
  todos.mutateUser(scope, {
    _tag: "Snooze",
    id: item.id,
    expectedRevision: item.revision,
    until: deadline,
  });

/** Real storage serialization, transactions and projection; only disk and unused session
 * boundaries are faked. No test can silently acquire a runtime to expire a to-do. */
function fixture() {
  let persisted = JSON.stringify(defaultApplicationState());
  let writes = 0;
  let fail = false;
  let beforeSave: Effect.Effect<void> = Effect.void;
  const app = ApplicationState.layer.pipe(
    Layer.provide(
      Layer.succeed(ApplicationStorage, {
        load: () =>
          Effect.sync(() => ({
            state: Schema.decodeUnknownSync(StateSchema)(JSON.parse(persisted)),
            source: "current" as const,
          })),
        save: (state) => {
          const gate = beforeSave;
          beforeSave = Effect.void;
          return gate.pipe(
            Effect.andThen(() =>
              fail
                ? Effect.fail(
                    new ApplicationWriteError({ stage: "write", message: "Disk unavailable" }),
                  )
                : Effect.sync(() => {
                    persisted = JSON.stringify(Schema.decodeUnknownSync(StateSchema)(state));
                    writes++;
                  }),
            ),
          );
        },
      }),
    ),
  );
  const layer = Layer.mergeAll(
    app,
    Layer.mock(CakeSessionRuntimes, {}),
    Layer.mock(SessionArchiveStorage, {}),
    Layer.mock(SessionFamilyStorage, {}),
    Layer.succeed(ProjectSessionConfiguration, {
      agentDirectory: "/agent",
      sessionDirectory: "/sessions",
      resolvedSessionDirectory: "/resolved",
    }),
    makeSubagentStorageTestLayer(),
    Layer.mock(ManagedWorktrees, {}),
  );
  return {
    layer,
    writes: () => writes,
    beforeSave: (effect: Effect.Effect<void>) => {
      beforeSave = effect;
    },
    fail: (value: boolean) => {
      fail = value;
    },
  };
}

it.effect.each([project, CAKE_CHAT_TODO_SCOPE])(
  "snoozes, changes deadline and manually unsnoozes %s without duplicate items or session changes",
  (scope) => {
    const f = fixture();
    return Effect.gen(function* () {
      yield* upsertProject(project, "Project");
      const item = yield* create(scope);
      yield* todos.mutateUser(scope, { _tag: "Select", selectedId: item.id });
      yield* snooze(item, scope);
      const value = yield* todos.list(scope);
      expect(value.items).toHaveLength(1);
      expect(value.items[0]).toMatchObject({ state: "open", snoozedUntil: until, revision: 1 });
      expect(value.selectedId).toBeNull();
      const baseline = projectTodoBaseline(value);
      expect(baseline).toContain('"active":[]');
      expect(baseline).toContain('"snoozedCount":1');
      expect(
        (yield* todos
          .mutateUser(scope, { _tag: "Select", selectedId: item.id })
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
      yield* snooze(yield* todos.read(scope, item.id), scope, later);
      expect((yield* controls.list(scope, { category: "active" })).items).toEqual([]);
      const list = yield* controls.list(scope, { category: "snoozed" });
      expect(list.items).toEqual([
        expect.objectContaining({ id: item.id, snoozedUntil: later, revision: 2 }),
      ]);
      expect((yield* controls.list(scope, { state: "open" })).items).toHaveLength(1);
      yield* todos.mutateUser(scope, { _tag: "Unsnooze", id: item.id, expectedRevision: 2 });
      expect(yield* todos.read(scope, item.id)).toMatchObject({ state: "open", revision: 3 });
      expect(yield* todos.read(scope, item.id)).not.toHaveProperty("snoozedUntil");
      yield* TestClock.setTime(3_600_001);
      yield* todos.expireOverdue();
      expect((yield* todos.read(scope, item.id)).revision).toBe(3);
      expect((yield* controls.list(scope, { category: "active" })).items).toHaveLength(1);
      expect((yield* controls.list(scope, { category: "snoozed" })).items).toEqual([]);
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect.each([
  "invalid",
  "2027-02-30T12:00:00.000Z",
  "2027-13-01T12:00:00.000Z",
  "2027-01-01T25:00:00.000Z",
  "2027-01-01T12:00",
  "2027-01-01T12:00:00.000",
  "1970-01-01T00:00:00.000Z",
  "1970-01-01T00:00:00Z",
  "1969-12-31T23:59:59.999Z",
])(
  "rejects malformed, impossible, ambiguous or non-future deadline %s without publishing",
  (deadline) => {
    const f = fixture();
    return Effect.gen(function* () {
      yield* upsertProject(project, "Project");
      const item = yield* create();
      const before = f.writes();
      const result = yield* snooze(item, project, deadline).pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      expect(f.writes()).toBe(before);
      expect(yield* todos.read(project, item.id)).toEqual(item);
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect("persisted UTC timestamps without milliseconds expire at the exact instant too", () => {
  const f = fixture();
  return Effect.gen(function* () {
    yield* upsertProject(project, "Project");
    const item = yield* create(CAKE_CHAT_TODO_SCOPE);
    const value = yield* todos.list(CAKE_CHAT_TODO_SCOPE);
    yield* (yield* ApplicationState).transact((state) =>
      Effect.succeed({
        ...state,
        cakeChatTodos: { ...value, items: [{ ...item, snoozedUntil: "1970-01-01T00:15:00Z" }] },
      }),
    );
    yield* TestClock.setTime(900_000);
    yield* todos.expireOverdue();
    expect(yield* todos.read(CAKE_CHAT_TODO_SCOPE, item.id)).not.toHaveProperty("snoozedUntil");
  }).pipe(Effect.provide(f.layer));
});

it.effect("a batch with a non-future deadline commits no partial snoozes", () => {
  const f = fixture();
  return Effect.gen(function* () {
    yield* upsertProject(project, "Project");
    const first = yield* create();
    const second = yield* create();
    const writes = f.writes();
    const result = yield* todos
      .updateMany(project, [
        { id: first.id, expectedRevision: 0, snoozedUntil: until },
        { id: second.id, expectedRevision: 0, snoozedUntil: "1970-01-01T00:00:00Z" },
      ])
      .pipe(Effect.result);
    expect(result._tag).toBe("Failure");
    expect(f.writes()).toBe(writes);
    expect(yield* todos.read(project, first.id)).toEqual(first);
    expect(yield* todos.read(project, second.id)).toEqual(second);
  }).pipe(Effect.provide(f.layer));
});

it.effect("revalidates a custom future deadline after waiting for the transaction lock", () => {
  const f = fixture();
  return Effect.gen(function* () {
    yield* upsertProject(project, "Project");
    const item = yield* create();
    const other = yield* create();
    const saving = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    f.beforeSave(Deferred.succeed(saving, undefined).pipe(Effect.andThen(Deferred.await(release))));
    const edit = yield* todos
      .update(project, { id: other.id, expectedRevision: 0, status: "Holding storage" })
      .pipe(Effect.forkChild);
    yield* Deferred.await(saving);
    const request = yield* Effect.forkChild(snooze(item).pipe(Effect.result), {
      startImmediately: true,
    });
    yield* TestClock.setTime(900_000);
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(edit);
    const result = yield* Fiber.join(request);
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure")
      expect(result.failure.message).toContain("must be in the future");
    expect(yield* todos.read(project, item.id)).toEqual(item);
  }).pipe(Effect.provide(f.layer));
});

it.effect.each([project, CAKE_CHAT_TODO_SCOPE])(
  "worker expires %s at its deadline with no open pane and no new reminders; idle passes never write",
  (scope) => {
    const f = fixture();
    return Effect.gen(function* () {
      yield* upsertProject(project, "Project");
      const item = yield* create(scope);
      yield* snooze(item, scope);
      const pending = (yield* todos.list(scope)).pending;
      yield* snoozes.initialize();
      const writes = f.writes();
      yield* TestClock.adjust(899_000);
      expect((yield* todos.read(scope, item.id)).snoozedUntil).toBe(until);
      expect(f.writes()).toBe(writes);
      yield* TestClock.adjust(1_000);
      expect(yield* todos.read(scope, item.id)).not.toHaveProperty("snoozedUntil");
      expect((yield* todos.read(scope, item.id)).state).toBe("open");
      expect((yield* todos.list(scope)).pending).toEqual(pending);
      expect(f.writes()).toBe(writes + 1);
      yield* TestClock.adjust(2_000);
      expect(f.writes()).toBe(writes + 1);
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect(
  "persisted future and overdue snoozes survive restart, and downtime is repaired before worker startup returns",
  () => {
    const f = fixture();
    return Effect.gen(function* () {
      const id = yield* Effect.gen(function* () {
        yield* upsertProject(project, "Project");
        const item = yield* create();
        yield* snooze(item);
        return item.id;
      }).pipe(Effect.provide(f.layer));
      yield* Effect.gen(function* () {
        yield* (yield* ApplicationState).initialize();
        yield* snoozes.initialize();
        expect((yield* todos.read(project, id)).snoozedUntil).toBe(until);
      }).pipe(Effect.provide(f.layer));
      yield* TestClock.setTime(1_800_000);
      yield* Effect.gen(function* () {
        yield* (yield* ApplicationState).initialize();
        yield* snoozes.initialize();
        expect(yield* todos.read(project, id)).not.toHaveProperty("snoozedUntil");
        expect((yield* todos.read(project, id)).revision).toBe(2);
      }).pipe(Effect.provide(f.layer));
      yield* Effect.gen(function* () {
        yield* (yield* ApplicationState).initialize();
        expect(yield* todos.read(project, id)).not.toHaveProperty("snoozedUntil");
      }).pipe(Effect.provide(f.layer));
    });
  },
);

it.effect.each(["user", "sessions"] as const)(
  "%s completion while snoozed clears deadline permanently; reopen never restores it",
  (by) => {
    const f = fixture();
    return Effect.gen(function* () {
      yield* upsertProject(project, "Project");
      const item = yield* create();
      yield* snooze(item);
      const current = yield* todos.read(project, item.id);
      if (by === "sessions") yield* todos.completeResolved(project, [current]);
      else
        yield* todos.mutateUser(project, {
          _tag: "SetState",
          id: item.id,
          expectedRevision: 1,
          state: "done",
        });
      const done = yield* todos.read(project, item.id);
      expect(done).toMatchObject({ state: "done", completion: { by } });
      expect(done).not.toHaveProperty("snoozedUntil");
      expect((yield* snooze(done).pipe(Effect.result))._tag).toBe("Failure");
      yield* TestClock.setTime(1_800_000);
      yield* todos.expireOverdue();
      expect(yield* todos.read(project, item.id)).toEqual(done);
      yield* todos.update(project, { id: item.id, expectedRevision: done.revision, state: "open" });
      expect(yield* todos.read(project, item.id)).not.toHaveProperty("snoozedUntil");
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect.each(["extend", "unsnooze", "done"] as const)(
  "serializes expiry racing %s and preserves the winning revision",
  (action) => {
    const f = fixture();
    return Effect.gen(function* () {
      yield* upsertProject(project, "Project");
      const item = yield* create();
      yield* snooze(item);
      yield* TestClock.setTime(900_000);
      const update =
        action === "extend"
          ? { snoozedUntil: later }
          : action === "unsnooze"
            ? { snoozedUntil: null }
            : { state: "done" as const };
      const [, mutation] = yield* Effect.all(
        [
          todos.expireOverdue(),
          todos
            .update(project, { id: item.id, expectedRevision: 1, ...update })
            .pipe(Effect.result),
        ],
        { concurrency: "unbounded" },
      );
      const current = yield* todos.read(project, item.id);
      if (mutation._tag === "Success") {
        expect(current).toEqual(mutation.success);
        if (action === "extend") expect(current.snoozedUntil).toBe(later);
        else expect(current).not.toHaveProperty("snoozedUntil");
      } else {
        expect(mutation.failure.message).toContain("current revision 2");
        expect(current).toMatchObject({ state: "open", revision: 2 });
        expect(current).not.toHaveProperty("snoozedUntil");
      }
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect.each(["extend", "unsnooze", "done"] as const)(
  "an expiry snapshot queued behind a saving %s cannot overwrite it",
  (action) => {
    const f = fixture();
    return Effect.gen(function* () {
      yield* upsertProject(project, "Project");
      const item = yield* create();
      yield* snooze(item);
      const saving = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      f.beforeSave(
        Deferred.succeed(saving, undefined).pipe(Effect.andThen(Deferred.await(release))),
      );
      const change =
        action === "extend"
          ? { snoozedUntil: later }
          : action === "unsnooze"
            ? { snoozedUntil: null }
            : { state: "done" as const };
      const edit = yield* todos
        .update(project, { id: item.id, expectedRevision: 1, ...change })
        .pipe(Effect.forkChild);
      yield* Deferred.await(saving);
      yield* TestClock.setTime(900_000);
      const expiry = yield* Effect.forkChild(todos.expireOverdue(), { startImmediately: true });
      yield* Deferred.succeed(release, undefined);
      const committed = yield* Fiber.join(edit);
      yield* Fiber.join(expiry);
      expect(yield* todos.read(project, item.id)).toEqual(committed);
      if (action === "extend") expect(committed.snoozedUntil).toBe(later);
      else expect(committed).not.toHaveProperty("snoozedUntil");
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect("failed persistence publishes nothing and expiry retries the overdue item", () => {
  const f = fixture();
  return Effect.gen(function* () {
    yield* upsertProject(project, "Project");
    const item = yield* create();
    yield* snooze(item);
    f.fail(true);
    yield* TestClock.setTime(900_000);
    expect((yield* todos.expireOverdue().pipe(Effect.result))._tag).toBe("Failure");
    expect((yield* todos.read(project, item.id)).snoozedUntil).toBe(until);
    f.fail(false);
    yield* todos.expireOverdue();
    expect(yield* todos.read(project, item.id)).not.toHaveProperty("snoozedUntil");
  }).pipe(Effect.provide(f.layer));
});

it.effect(
  "snooze/unsnooze tools use the real revision-checked shared list, validate dates and reject stale edits",
  () => {
    const f = fixture();
    return Effect.gen(function* () {
      yield* upsertProject(project, "Project");
      const item = yield* create();
      const context = yield* Effect.context<Layer.Success<typeof f.layer>>();
      const run = <A, E>(effect: Effect.Effect<A, E, Layer.Success<typeof f.layer>>) =>
        Effect.runPromise(effect.pipe(Effect.provide(context)));
      const registry = new CakeOperationRegistry(
        createProjectTodoOperations({
          list: (input) => run(controls.list(project, input)),
          read: (id) => run(controls.read(project, id)),
          create: (input) => run(controls.create(project, input)),
          update: (input) => run(controls.update(project, input)),
          updateMany: (input) => run(controls.updateMany(project, input)),
        }),
      );
      const execution = { signal: new AbortController().signal, toolCallId: "test", runtime: {} };
      const invoke = (command: string, input: unknown) =>
        Effect.tryPromise({
          try: () => registry.invoke({ command, input }, execution),
          catch: (cause) => cause,
        });
      const snoozed = yield* invoke("todos.snooze", { id: item.id, expectedRevision: 0, until });
      expect(snoozed.structuredContent).toMatchObject({
        result: { revision: 1, committed: true, snoozedUntil: until },
      });
      expect((yield* todos.read(project, item.id)).snoozedUntil).toBe(until);
      const stale = yield* invoke("todos.unsnooze", { id: item.id, expectedRevision: 0 }).pipe(
        Effect.result,
      );
      expect(stale._tag).toBe("Failure");
      const invalid = yield* invoke("todos.snooze", {
        id: item.id,
        expectedRevision: 1,
        until: "2027-02-30T00:00:00.000Z",
      }).pipe(Effect.result);
      expect(invalid._tag).toBe("Failure");
      const past = yield* invoke("todos.snooze", {
        id: item.id,
        expectedRevision: 1,
        until: "1970-01-01T00:00:00Z",
      }).pipe(Effect.result);
      expect(past._tag).toBe("Failure");
      const cleared = yield* invoke("todos.unsnooze", { id: item.id, expectedRevision: 1 });
      expect(cleared.structuredContent).toMatchObject({
        result: { revision: 2, committed: true, snoozedUntil: null },
      });
      expect(yield* todos.read(project, item.id)).not.toHaveProperty("snoozedUntil");
      expect(
        Schema.is(ProjectTodoSnooze)({
          id: item.id,
          expectedRevision: 2,
          until: "2027-01-01T12:00:00Z",
        }),
      ).toBe(true);
    }).pipe(Effect.provide(f.layer));
  },
);
