import { it } from "@effect/vitest";
import { expect } from "vitest";
import { Effect, Layer, Schema } from "effect";
import { CakeSessionRuntimes } from "../../../src/services/pi/CakeSessionRuntimes";
import { SessionArchiveStorage } from "../../../src/services/storage/SessionArchiveStorage";
import { SessionFamilyStorage } from "../../../src/services/storage/SessionFamilyStorage";
import { ProjectSessionConfiguration } from "../../../src/services/project-sessions/ProjectSessionConfiguration";
import { ManagedWorktrees } from "../../../src/services/worktrees/ManagedWorktrees";
import { TestClock } from "effect/testing";
import type { ApplicationState } from "../../../src/services/storage/ApplicationState";
import { projectTodoLayer } from "../helpers/projectTodoHarness";
import {
  CAKE_CHAT_TODO_SCOPE,
  ProjectTodo,
  projectTodoCategory,
  projectTodoBaseline,
} from "../../../src/contracts/projects/project-todos";
import { projectTodoContextPresentation } from "../../../src/contracts/projects/project-todo-context";
import * as todos from "../../../src/domain/projects/projectTodos";
import * as controls from "../../../src/domain/projects/projectTodoAssociations";
import { createProjectTodoOperations } from "../../../src/domain/projects/project-todo-operations";
import { CakeOperationRegistry } from "../../../src/services/pi/runtime/cake-operation-registry";

const scope = "/project";
const reason = "Review the startup findings";
const create = (owner = scope) =>
  todos.create(owner, {
    title: "Startup investigation",
    description: "Findings are ready.",
    needsAttention: true,
    attentionReason: reason,
  });

it.effect.each([scope, CAKE_CHAT_TODO_SCOPE])(
  "retains dismissed requests, suppresses agent repeats, and permits explicit restore and genuinely new requests in %s",
  (owner) =>
    Effect.gen(function* () {
      let item = yield* create(owner);
      yield* todos.mutateUser(owner, { _tag: "Select", selectedId: item.id });
      const dismissed = yield* todos.mutateUser(owner, {
        _tag: "SetAttention",
        id: item.id,
        expectedRevision: item.revision,
        needsAttention: false,
      });
      item = dismissed.items[0]!;
      expect(item).toMatchObject({ state: "open", needsAttention: false, attentionReason: reason });
      expect(dismissed.selectedId).toBe(item.id);
      expect(projectTodoCategory(item)).toBe("active");
      const reminder = yield* todos.prepareUserContext(owner, "Continue");
      expect(reminder.text).toContain('"_tag":"Attention"');
      expect(reminder.text).toContain('"needsAttention":false');
      expect(projectTodoContextPresentation(reminder.text).text).toContain("attention dismissed");
      expect(projectTodoBaseline(dismissed)).toContain(
        '"attentionReason":"Review the startup findings"',
      );
      expect(projectTodoBaseline(dismissed)).toContain('"activeCount":1');
      expect(projectTodoBaseline(dismissed)).toContain('"attentionCount":0');
      item = yield* todos.update(owner, {
        id: item.id,
        expectedRevision: item.revision,
        needsAttention: true,
        attentionReason: reason,
      });
      expect(item.needsAttention).toBe(false);
      item = yield* todos.update(owner, {
        id: item.id,
        expectedRevision: item.revision,
        needsAttention: true,
      });
      expect(item.needsAttention).toBe(false);
      yield* todos.applyReportDescription(owner, item, "A new summary, not a new request.");
      item = yield* todos.read(owner, item.id);
      expect(item).toMatchObject({ needsAttention: false, attentionReason: reason });
      item = (yield* todos.mutateUser(owner, {
        _tag: "SetAttention",
        id: item.id,
        expectedRevision: item.revision,
        needsAttention: true,
      })).items[0]!;
      expect(item.needsAttention).toBe(true);
      item = (yield* todos.mutateUser(owner, {
        _tag: "SetAttention",
        id: item.id,
        expectedRevision: item.revision,
        needsAttention: false,
      })).items[0]!;
      item = yield* todos.update(owner, {
        id: item.id,
        expectedRevision: item.revision,
        needsAttention: true,
        attentionReason: "Approve the revised startup scope",
      });
      expect(projectTodoCategory(item)).toBe("attention");
      expect((yield* todos.list(owner)).items).toHaveLength(1);
    }).pipe(Effect.provide(projectTodoLayer())),
);

it.effect.each(["", "   ", "x".repeat(513)])(
  "rejects invalid reason %s on create/update without committing",
  (attentionReason) =>
    Effect.gen(function* () {
      expect(
        (yield* todos
          .create(scope, {
            title: "Task",
            description: "Update",
            needsAttention: true,
            attentionReason,
          })
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
      const item = yield* create();
      expect(
        (yield* todos
          .update(scope, { id: item.id, expectedRevision: 0, attentionReason })
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
      expect(yield* todos.read(scope, item.id)).toEqual(item);
    }).pipe(Effect.provide(projectTodoLayer())),
);

it.effect(
  "requires a reason for attention and accepts existing saved items with no invented reason",
  () =>
    Effect.gen(function* () {
      expect(
        (yield* todos
          .create(scope, { title: "Task", description: "Update", needsAttention: true })
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
      const item = yield* todos.create(scope, {
        title: "Task",
        description: "Update",
        needsAttention: false,
      });
      expect(
        (yield* todos
          .update(scope, { id: item.id, expectedRevision: 0, needsAttention: true })
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
      expect(
        (yield* todos
          .mutateUser(scope, {
            _tag: "SetAttention",
            id: item.id,
            expectedRevision: 0,
            needsAttention: true,
          })
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
      const old = { ...item };
      delete old.needsAttention;
      expect(Schema.decodeUnknownSync(ProjectTodo)(old)).not.toHaveProperty("attentionReason");
      expect(() =>
        Schema.decodeUnknownSync(ProjectTodo)({ ...old, needsAttention: true }),
      ).toThrow();
    }).pipe(Effect.provide(projectTodoLayer())),
);

it.effect(
  "snoozing wins visibility, attention edits never unsnooze, expiry respects attention, and completion/reopen clears only the flag",
  () =>
    Effect.gen(function* () {
      let item = yield* create();
      const until = "1970-01-01T01:00:00.000Z";
      item = yield* todos.update(scope, {
        id: item.id,
        expectedRevision: item.revision,
        snoozedUntil: until,
      });
      expect(projectTodoCategory(item)).toBe("snoozed");
      item = (yield* todos.mutateUser(scope, {
        _tag: "SetAttention",
        id: item.id,
        expectedRevision: item.revision,
        needsAttention: false,
      })).items[0]!;
      expect(item.snoozedUntil).toBe(until);
      item = (yield* todos.mutateUser(scope, {
        _tag: "SetAttention",
        id: item.id,
        expectedRevision: item.revision,
        needsAttention: true,
        attentionReason: "Choose sidebar or tabs",
      })).items[0]!;
      expect(item.snoozedUntil).toBe(until);
      expect(projectTodoCategory(item)).toBe("snoozed");
      yield* TestClock.setTime(3_600_000);
      yield* todos.expireOverdue();
      item = yield* todos.read(scope, item.id);
      expect(projectTodoCategory(item)).toBe("attention");
      item = yield* todos.update(scope, {
        id: item.id,
        expectedRevision: item.revision,
        state: "done",
      });
      expect(item).toMatchObject({
        state: "done",
        needsAttention: false,
        attentionReason: "Choose sidebar or tabs",
      });
      item = yield* todos.update(scope, {
        id: item.id,
        expectedRevision: item.revision,
        needsAttention: true,
        attentionReason: "Review the change before merging",
      });
      expect(projectTodoCategory(item)).toBe("done");
      item = yield* todos.update(scope, {
        id: item.id,
        expectedRevision: item.revision,
        state: "open",
        needsAttention: true,
      });
      expect(projectTodoCategory(item)).toBe("active");
      expect(item.attentionReason).toBe("Review the change before merging");
      item = (yield* todos.mutateUser(scope, {
        _tag: "SetAttention",
        id: item.id,
        expectedRevision: item.revision,
        needsAttention: true,
      })).items[0]!;
      yield* todos.completeResolved(scope, [item]);
      expect(yield* todos.read(scope, item.id)).toMatchObject({
        needsAttention: false,
        completion: { by: "sessions" },
        attentionReason: item.attentionReason,
      });
    }).pipe(Effect.provide(projectTodoLayer())),
);

it.effect("attention validation and revision conflicts keep an update batch atomic", () =>
  Effect.gen(function* () {
    const first = yield* create();
    const second = yield* todos.create(scope, { title: "Other", description: "In progress." });
    expect(
      (yield* todos
        .updateMany(scope, [
          { id: first.id, expectedRevision: 0, needsAttention: false },
          { id: second.id, expectedRevision: 0, needsAttention: true },
        ])
        .pipe(Effect.result))._tag,
    ).toBe("Failure");
    expect(yield* todos.read(scope, first.id)).toEqual(first);
    yield* todos.mutateUser(scope, {
      _tag: "SetAttention",
      id: first.id,
      expectedRevision: 0,
      needsAttention: false,
    });
    expect(
      (yield* todos
        .updateMany(scope, [
          { id: second.id, expectedRevision: 0, title: "Must not commit" },
          {
            id: first.id,
            expectedRevision: 0,
            needsAttention: true,
            attentionReason: "New request",
          },
        ])
        .pipe(Effect.result))._tag,
    ).toBe("Failure");
    expect(yield* todos.read(scope, second.id)).toEqual(second);
    expect((yield* todos.read(scope, first.id)).needsAttention).toBe(false);
  }).pipe(Effect.provide(projectTodoLayer())),
);

it.effect(
  "agent list/read and compact receipts expose canonical attention and retained dismissed reasons",
  () =>
    Effect.gen(function* () {
      let item = yield* create();
      expect((yield* controls.list(scope, { category: "attention" })).items).toEqual([
        expect.objectContaining({ needsAttention: true, attentionReason: reason }),
      ]);
      expect((yield* controls.list(scope, { category: "active" })).items).toEqual([]);
      item = (yield* todos.mutateUser(scope, {
        _tag: "SetAttention",
        id: item.id,
        expectedRevision: 0,
        needsAttention: false,
      })).items[0]!;
      expect((yield* controls.list(scope, { category: "active" })).items[0]).toMatchObject({
        needsAttention: false,
        attentionReason: reason,
      });
      const app = yield* Effect.context<ApplicationState>();
      const run = <A, E>(effect: Effect.Effect<A, E, ApplicationState>) =>
        Effect.runPromise(effect.pipe(Effect.provide(app)));
      const registry = new CakeOperationRegistry(
        createProjectTodoOperations({
          list: async () => {
            throw new Error("Registry list is not used here");
          },
          read: (id) =>
            run(todos.read(scope, id).pipe(Effect.map((value) => ({ ...value, sessions: [] })))),
          create: (input) => run(todos.create(scope, input)),
          update: (input) => run(todos.update(scope, input)),
          updateMany: (input) => run(todos.updateMany(scope, input)),
        }),
      );
      const result = yield* Effect.promise(() =>
        registry.invoke(
          {
            command: "todos.update",
            input: {
              id: item.id,
              expectedRevision: item.revision,
              needsAttention: true,
              attentionReason: reason,
            },
          },
          { signal: new AbortController().signal, toolCallId: "attention", runtime: {} },
        ),
      );
      expect(result.structuredContent).toMatchObject({
        result: { committed: true, needsAttention: false, attentionReason: reason },
      });
      expect((yield* todos.read(scope, item.id)).needsAttention).toBe(false);
      const detail = yield* Effect.promise(() =>
        registry.invoke(
          { command: "todos.read", input: { id: item.id } },
          { signal: new AbortController().signal, toolCallId: "attention-read", runtime: {} },
        ),
      );
      expect(detail.structuredContent).toMatchObject({
        result: { needsAttention: false, attentionReason: reason, state: "open" },
      });
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          projectTodoLayer(),
          Layer.mock(CakeSessionRuntimes, {}),
          Layer.mock(SessionArchiveStorage, {}),
          Layer.mock(SessionFamilyStorage, {}),
          Layer.succeed(ProjectSessionConfiguration, {
            agentDirectory: "/agent",
            sessionDirectory: "/sessions",
            resolvedSessionDirectory: "/resolved",
          }),
          Layer.mock(ManagedWorktrees, {}),
        ),
      ),
    ),
);
