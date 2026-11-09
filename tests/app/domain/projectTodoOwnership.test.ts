import { it } from "@effect/vitest";
import { expect } from "vitest";
import { Effect, Result, Schema } from "effect";
import {
  CAKE_CHAT_TODO_SCOPE,
  ProjectTodos,
  emptyProjectTodos,
  type ProjectTodo,
} from "../../../src/contracts/projects/project-todos";
import {
  CAKE_CHAT_SESSION_ID,
  cakeChatSideChatSessionId,
} from "../../../src/contracts/cake-chats/cake-chat-identity";
import { ApplicationState } from "../../../src/services/storage/ApplicationState";
import * as todos from "../../../src/domain/projects/projectTodos";
import { projectTodoLayer } from "../helpers/projectTodoHarness";

const project = "/project";
const a = "00000000-0000-4000-8000-000000000011";
const b = "00000000-0000-4000-8000-000000000022";
const link = (sessionId: string) => ({ kind: "session" as const, sessionId, title: "Work" });
const create = (scope = project, sessionIds: string[] = []) =>
  todos.create(scope, {
    title: "Work",
    description: "Implement the change.",
    associations: sessionIds.map(link),
  });

it.effect.each(["open", "done"] as const)(
  "rejects create/update conflicts with a %s owner across both lists without partial writes",
  (state) =>
    Effect.gen(function* () {
      let owner = yield* create(project, [a]);
      if (state === "done")
        owner = yield* todos.update(project, { id: owner.id, expectedRevision: 0, state });
      const target = yield* create(CAKE_CHAT_TODO_SCOPE);
      const before = (yield* ApplicationState).snapshot();
      const duplicate = yield* create(CAKE_CHAT_TODO_SCOPE, [a]).pipe(Effect.flip);
      expect(duplicate.message).toContain(owner.id);
      expect(duplicate.message).toContain(project);
      expect(duplicate.message).toContain("Read/update");
      const conflict = yield* todos
        .updateMany(CAKE_CHAT_TODO_SCOPE, [
          { id: target.id, expectedRevision: 0, associations: [link(a)], title: "Must roll back" },
        ])
        .pipe(Effect.flip);
      expect(conflict.message).toContain(owner.id);
      expect((yield* ApplicationState).snapshot()).toEqual(before);
      // Completion and reopening do not release the ownership claim.
      if (state === "done") {
        yield* todos.update(project, {
          id: owner.id,
          expectedRevision: owner.revision,
          state: "open",
        });
        expect((yield* create(project, [a]).pipe(Effect.flip)).message).toContain(owner.id);
      }
    }).pipe(Effect.provide(projectTodoLayer())),
);

it.effect(
  "explicit admission rechecks open state at the serialized commit and never overwrites concurrent work",
  () =>
    Effect.gen(function* () {
      const task = yield* create();
      const scope = yield* todos.existingTaskScope(project, task.id);
      yield* todos.update(project, { id: task.id, expectedRevision: task.revision, state: "done" });
      const before = (yield* ApplicationState).snapshot();
      const failure = yield* todos.attachExisting(scope, task.id, link(a)).pipe(Effect.flip);
      expect(failure.message).toContain("open outcome");
      expect((yield* ApplicationState).snapshot()).toEqual(before);
    }).pipe(Effect.provide(projectTodoLayer())),
);

it.effect("same-owner links are idempotent while one item can own several sessions", () =>
  Effect.gen(function* () {
    const owner = yield* create(project, [a]);
    const updated = yield* todos.update(project, {
      id: owner.id,
      expectedRevision: 0,
      associations: [link(a), link(b)],
    });
    expect(updated.associations).toEqual([link(a), link(b)]);
    expect(updated.revision).toBe(1);
    const repeated = yield* todos.update(project, {
      id: owner.id,
      expectedRevision: 0,
      associations: [link(a), link(b)],
    });
    expect(repeated).toEqual(updated);
    const renamed = yield* todos.update(project, {
      id: owner.id,
      expectedRevision: 1,
      title: "Renamed",
      associations: [link(a), link(b)],
    });
    expect(renamed).toMatchObject({ title: "Renamed", revision: 2 });
    yield* todos.ensureSession(project, b, "Automatic retry", "Must reuse owner.");
    expect((yield* todos.list(project)).items).toEqual([renamed]);
  }).pipe(Effect.provide(projectTodoLayer())),
);

it.effect("conflicting batch additions roll back all items; deliberate atomic transfers work", () =>
  Effect.gen(function* () {
    const first = yield* create(project, [a]);
    const second = yield* create();
    const before = yield* todos.list(project);
    yield* todos
      .updateMany(project, [
        { id: first.id, expectedRevision: 0, title: "Must not commit" },
        { id: second.id, expectedRevision: 0, associations: [link(a)] },
      ])
      .pipe(Effect.flip);
    expect(yield* todos.list(project)).toEqual(before);
    // Validate final state, not input order.
    yield* todos.updateMany(project, [
      { id: second.id, expectedRevision: 0, associations: [link(a)] },
      { id: first.id, expectedRevision: 0, associations: [] },
    ]);
    expect((yield* todos.read(project, second.id)).associations).toEqual([link(a)]);
    expect((yield* todos.read(project, first.id)).associations).toEqual([]);
    yield* todos.ensureSession(CAKE_CHAT_TODO_SCOPE, a, "Retry", "No orphan automatic item.");
    expect((yield* todos.list(CAKE_CHAT_TODO_SCOPE)).items).toEqual([]);
  }).pipe(Effect.provide(projectTodoLayer())),
);

it.effect.each(["create", "update"] as const)(
  "serializes concurrent %s claims across scopes with exactly one winner",
  (operation) =>
    Effect.gen(function* () {
      const first = yield* create();
      const second = yield* create(CAKE_CHAT_TODO_SCOPE);
      const results = yield* Effect.all(
        [
          (operation === "create"
            ? create(project, [a])
            : todos.update(project, {
                id: first.id,
                expectedRevision: 0,
                associations: [link(a)],
              })
          ).pipe(Effect.result),
          (operation === "create"
            ? create(CAKE_CHAT_TODO_SCOPE, [a])
            : todos.update(CAKE_CHAT_TODO_SCOPE, {
                id: second.id,
                expectedRevision: 0,
                associations: [link(a)],
              })
          ).pipe(Effect.result),
        ],
        { concurrency: "unbounded" },
      );
      expect(results.filter(Result.isSuccess)).toHaveLength(1);
      expect(results.filter(Result.isFailure)).toHaveLength(1);
      const items = [
        ...(yield* todos.list(project)).items,
        ...(yield* todos.list(CAKE_CHAT_TODO_SCOPE)).items,
      ];
      const owners = items.filter((item) =>
        item.associations.some(
          (association) => association.kind === "session" && association.sessionId === a,
        ),
      );
      expect(owners).toHaveLength(1);
      const failure = results.find(Result.isFailure);
      expect(failure?.failure.message).toContain(owners[0]?.id);
    }).pipe(Effect.provide(projectTodoLayer())),
);

it.effect.each(["automatic-first", "explicit-first"] as const)(
  "automatic and explicit creation racing (%s) never leave an orphan or duplicate",
  (order) =>
    Effect.gen(function* () {
      const automatic = todos
        .ensureSession(project, a, "Automatic", "Session admission.")
        .pipe(Effect.result);
      const explicit = create(CAKE_CHAT_TODO_SCOPE, [a]).pipe(Effect.result);
      yield* Effect.all(
        order === "automatic-first" ? [automatic, explicit] : [explicit, automatic],
        { concurrency: "unbounded" },
      );
      const items = [
        ...(yield* todos.list(project)).items,
        ...(yield* todos.list(CAKE_CHAT_TODO_SCOPE)).items,
      ];
      expect(items).toHaveLength(1);
      expect(items[0]?.associations).toEqual([
        expect.objectContaining({ kind: "session", sessionId: a }),
      ]);
      yield* todos.ensureSession(CAKE_CHAT_TODO_SCOPE, a, "Retry", "No second item.");
      expect([
        ...(yield* todos.list(project)).items,
        ...(yield* todos.list(CAKE_CHAT_TODO_SCOPE)).items,
      ]).toEqual(items);
    }).pipe(Effect.provide(projectTodoLayer())),
);

it.effect("automatic bookkeeping reuses done owners even when the destination list is full", () => {
  const owner: ProjectTodo = {
    id: "10000000-0000-4000-8000-000000000001",
    title: "Owner",
    description: "Saved work.",
    status: "",
    revision: 0,
    state: "done",
    associations: [link(a)],
  };
  return Effect.gen(function* () {
    yield* todos.ensureSession(CAKE_CHAT_TODO_SCOPE, a, "Retry", "Reuse the Project owner.");
    expect((yield* todos.list(project)).items).toEqual([owner]);
    expect((yield* todos.list(CAKE_CHAT_TODO_SCOPE)).items).toHaveLength(1000);
  }).pipe(
    Effect.provide(
      projectTodoLayer({
        initialTodos: { ...emptyProjectTodos(), items: [owner] },
        initialCakeChatTodos: {
          ...emptyProjectTodos(),
          items: Array.from({ length: 1000 }, (_, i) => ({
            ...owner,
            id: `20000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
            associations: [],
          })),
        },
      }),
    ),
  );
});

it.effect(
  "preserves historical cross-scope duplicates, blocks additions and reports ambiguous automatic ownership",
  () => {
    const first: ProjectTodo = {
      id: "10000000-0000-4000-8000-000000000001",
      title: "First task",
      description: "Distinct user work.",
      status: "",
      revision: 0,
      state: "done",
      associations: [link(a)],
    };
    const second: ProjectTodo = {
      ...first,
      id: "20000000-0000-4000-8000-000000000002",
      title: "Second task",
      state: "open",
    };
    const legacy = { ...emptyProjectTodos(), items: [first] };
    expect(Schema.is(ProjectTodos)(legacy)).toBe(true);
    return Effect.gen(function* () {
      const failure = yield* todos
        .ensureSession(project, a, "Retry", "Must not choose a task.")
        .pipe(Effect.flip);
      expect(failure.message).toContain(first.id);
      expect(failure.message).toContain(second.id);
      expect((yield* create(project, [a]).pipe(Effect.flip)).message).toContain(second.id);
      expect((yield* todos.list(project)).items).toEqual([first]);
      expect((yield* todos.list(CAKE_CHAT_TODO_SCOPE)).items).toEqual([second]);
      // Metadata, same-owner updates and lifecycle remain usable on duplicate data.
      yield* todos.update(project, {
        id: first.id,
        expectedRevision: 0,
        title: "Keep distinct task",
        associations: first.associations,
      });
      yield* todos.completeResolved(CAKE_CHAT_TODO_SCOPE, [second]);
      expect((yield* todos.read(CAKE_CHAT_TODO_SCOPE, second.id)).state).toBe("done");
      // Only an intentional removal resolves the ambiguity; neither task is deleted.
      yield* todos.update(CAKE_CHAT_TODO_SCOPE, {
        id: second.id,
        expectedRevision: 1,
        associations: [],
      });
      yield* todos.ensureSession(CAKE_CHAT_TODO_SCOPE, a, "Retry", "Reuse remaining owner.");
      expect((yield* todos.list(CAKE_CHAT_TODO_SCOPE)).items).toHaveLength(1);
      expect((yield* todos.list(project)).items).toHaveLength(1);
    }).pipe(
      Effect.provide(
        projectTodoLayer({
          initialTodos: legacy,
          initialCakeChatTodos: { ...emptyProjectTodos(), items: [second] },
        }),
      ),
    );
  },
);

it.effect("historical suffix links reserve their canonical session without being rewritten", () =>
  Effect.gen(function* () {
    const legacy = yield* create(project, ["00000011"]);
    expect((yield* create(CAKE_CHAT_TODO_SCOPE, [a]).pipe(Effect.flip)).message).toContain(
      legacy.id,
    );
    yield* todos.ensureSession(CAKE_CHAT_TODO_SCOPE, a, "Retry", "Reuse legacy owner.");
    expect((yield* todos.list(CAKE_CHAT_TODO_SCOPE)).items).toEqual([]);
    expect((yield* todos.read(project, legacy.id)).associations).toEqual([link("00000011")]);
  }).pipe(Effect.provide(projectTodoLayer())),
);

it.effect(
  "citations, permanent chats, side chats and subagent handles do not claim Project Session ownership",
  () =>
    Effect.gen(function* () {
      const associations = [
        link(CAKE_CHAT_SESSION_ID),
        link(cakeChatSideChatSessionId(2)),
        { kind: "source" as const, ref: `cake://session/${a}?message=report`, title: "Report" },
        {
          kind: "subagent" as const,
          parentSessionId: a,
          handleId: "10000000-0000-4000-8000-000000000001",
          title: "Worker",
        },
      ];
      for (const scope of [project, CAKE_CHAT_TODO_SCOPE])
        yield* todos.create(scope, {
          title: "Review",
          description: "Review shared context.",
          associations,
        });
      yield* create(project, [a]);
      expect((yield* todos.list(project)).items).toHaveLength(2);
      expect((yield* todos.list(CAKE_CHAT_TODO_SCOPE)).items).toHaveLength(1);
    }).pipe(Effect.provide(projectTodoLayer())),
);
