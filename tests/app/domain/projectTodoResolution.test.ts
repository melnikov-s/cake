import {
  makeSubagentStorageTestLayer,
  subagentHistoryFixture,
} from "../helpers/subagentStorageFixture";
import { SubagentHandleId } from "../../../src/contracts/subagents/subagent-data";
import {
  subagentLink,
  parseSubagentLink,
} from "../../../src/contracts/subagents/subagent-reference";
import type {
  SubagentRecord,
  SubagentHistory,
} from "../../../src/services/storage/SubagentStorage";
import { it } from "@effect/vitest";
import { seedHistoricalTodo } from "../helpers/projectTodoHarness";
import { TestClock } from "effect/testing";
import * as snoozes from "../../../src/domain/projects/projectTodoSnoozes";
import { expect } from "vitest";
import { Deferred, Effect, Fiber, Layer, Schema, Stream } from "effect";
import { defaultApplicationState } from "../../../src/contracts/application/application-data";
import { ApplicationState } from "../../../src/services/storage/ApplicationState";
import { ApplicationStorage } from "../../../src/services/storage/ApplicationStorage";
import { SessionFamilyStorage } from "../../../src/services/storage/SessionFamilyStorage";
import { SessionArchiveStorage } from "../../../src/services/storage/SessionArchiveStorage";
import { CakeSessionRuntimes } from "../../../src/services/pi/CakeSessionRuntimes";
import { ProjectSessionConfiguration } from "../../../src/services/project-sessions/ProjectSessionConfiguration";
import { ManagedWorktrees } from "../../../src/services/worktrees/ManagedWorktrees";
import { sessionDirectoryPath } from "../../../src/services/storage/session-files";
import { upsertProject } from "../../../src/domain/application/application";
import * as todos from "../../../src/domain/projects/projectTodos";
import * as controls from "../../../src/domain/projects/projectTodoAssociations";
import {
  completeLinked,
  completeLinkedForProject,
  join,
  recordLifecycle,
} from "../../../src/domain/projects/projectTodoResolution";
import { splitProjectTodoReminder } from "../../../src/contracts/projects/project-todo-context";
import { CAKE_CHAT_SESSION_ID } from "../../../src/contracts/cake-chats/cake-chat-identity";
import { createProjectTodoOperations } from "../../../src/domain/projects/project-todo-operations";
import { CakeOperationRegistry } from "../../../src/services/pi/runtime/cake-operation-registry";
import {
  CAKE_CHAT_TODO_SCOPE,
  ProjectTodoList,
  type ProjectTodoControl,
} from "../../../src/contracts/projects/project-todos";

const project = "/project";
const a = "00000000-0000-4000-8000-000000000011";
const b = "00000000-0000-4000-8000-000000000022";
const root = "00000000-0000-4000-8000-000000000033";
const directory = sessionDirectoryPath({ workingDirectory: project, root: "/sessions" });
const link = (sessionId: string) => ({ kind: "session" as const, sessionId, title: "Work" });

function fixture(
  workers: readonly SubagentRecord[] = [],
  history: readonly SubagentHistory[] = [],
) {
  let state = defaultApplicationState();
  const resolved = new Set<string>();
  const reads = { index: 0, family: 0, identities: 0, writes: 0 };
  const app = ApplicationState.layer.pipe(
    Layer.provide(
      Layer.succeed(ApplicationStorage, {
        load: () => Effect.succeed({ state, source: "current" as const }),
        save: (next) =>
          Effect.sync(() => {
            state = next;
            reads.writes++;
          }),
      }),
    ),
  );
  const layer = Layer.mergeAll(
    app,
    makeSubagentStorageTestLayer(workers, history),
    Layer.mock(SessionArchiveStorage, {
      resolvedProjectEntry: () => Effect.succeed(undefined),
      locate: (sessionId) =>
        Effect.succeed(resolved.has(sessionId) ? ("resolved" as const) : ("active" as const)),
      resolvedProjects: () => Stream.empty,
      resolutionSnapshot: () =>
        Effect.sync(() => {
          reads.index++;
          return { version: 1 as const, directories: { [directory]: [...resolved] } };
        }),
    }),
    Layer.mock(SessionFamilyStorage, {
      familyForMember: () => Effect.succeed(undefined),
      state: () =>
        Effect.sync(() => {
          reads.family++;
          return {
            families: [
              {
                familyId: "family",
                parentSessionId: root,
                workingDirectory: project,
                projectPath: project,
                createdAt: "2026-01-01",
                children: [
                  {
                    sessionId: b,
                    parentSessionId: root,
                    workingDirectory: "/retired-child",
                    requestId: "child",
                    createdAt: "2026-01-01",
                  },
                ],
              },
            ],
            turns: [],
            spawnedSessions: [],
          };
        }),
    }),
    Layer.mock(CakeSessionRuntimes, {
      catalogSnapshot: (query) =>
        Effect.succeed({
          directory: query.sessionDirectory,
          workingDirectory: query.workingDirectory,
          shared: false,
          find: (id) =>
            [a, b, root].includes(id) ? `${query.sessionDirectory}/${id}.jsonl` : undefined,
        }),
      currentStatus: () => Effect.succeed(undefined),
      catalogEntry: (_query, sessionId) =>
        Effect.succeed({
          id: sessionId,
          title: "Work",
          created: "2026-01-01",
          modified: "2026-01-01",
          messageCount: 1,
          resolved: resolved.has(sessionId),
        }),
      sessionIds: () =>
        Stream.fromEffect(
          Effect.sync(() => {
            reads.identities++;
            return [a, b, root];
          }),
        ).pipe(Stream.flatMap(Stream.fromIterable)),
    }),
    Layer.mock(ManagedWorktrees, { records: () => Effect.succeed([]) }),
    Layer.succeed(ProjectSessionConfiguration, {
      agentDirectory: "/agent",
      sessionDirectory: "/sessions",
      resolvedSessionDirectory: "/resolved",
    }),
  );
  return { layer, resolved, reads };
}

const worker: SubagentRecord = {
  handleId: SubagentHandleId.make("10000000-0000-4000-8000-000000000001"),
  privateSessionId: "private-pi-session",
  parentSessionId: a,
  parentProfile: "ProjectSession",
  parentWorkingDirectory: project,
  parentSessionDirectory: directory,
  anchorPartId: "worker-start",
  workingDirectory: project,
  projectPath: project,
  task: "Investigate",
  allowMutations: false,
  resolvedModel: {
    requested: "current",
    source: "current",
    provider: "test",
    modelId: "test",
    thinkingLevel: "off",
    fallbacks: [],
  },
  fastMode: false,
  tools: ["read"],
  inputReferences: [],
  messageReferences: [],
  notifyOnCompletion: false,
  completionId: "completion",
  completionDisposition: "notified",
  status: "complete",
  pendingInputs: [],
};

it.effect.each(["running", "complete", "error"] as const)(
  "all required sessions own completion despite remaining work and supporting %s subagents",
  (status) => {
    const f = fixture([{ ...worker, status }]);
    return Effect.gen(function* () {
      yield* upsertProject(project, "Project");
      let task = yield* controls.create(project, {
        title: "One outcome",
        description: "Investigate then implement and review.",
        needsAttention: true,
        attentionReason: "Review the final outcome",
        associations: [
          { kind: "subagent", parentSessionId: a, handleId: worker.handleId, title: "Findings" },
        ],
      });
      yield* completeLinked(project);
      expect((yield* controls.read(project, task.id)).sessions).toEqual([]);
      expect((yield* todos.read(project, task.id)).state).toBe("open");
      // The completed investigator is evidence, never an unresolvable required Project Session.
      yield* todos.attachExisting(project, task.id, link(a));
      task = yield* todos.read(project, task.id);
      task = yield* controls.update(project, {
        id: task.id,
        expectedRevision: task.revision,
        remainingWork: "Independent review still needed",
      });
      // Required follow-up work must be linked, not expressed as a prose closure veto.
      yield* todos.attachExisting(project, task.id, link(root));
      f.resolved.add(a); // actual lifecycle authority, not a report or merge
      yield* completeLinked(project);
      expect((yield* controls.list(project, { view: "reconciliation" })).items[0]).toMatchObject({
        id: task.id,
        state: "open",
        remainingWork: "Independent review still needed",
      });
      task = yield* todos.read(project, task.id);
      const denied = yield* controls
        .update(project, {
          id: task.id,
          expectedRevision: task.revision,
          state: "done",
          remainingWork: null,
        })
        .pipe(Effect.flip);
      expect(denied.message).toContain("unresolved required sessions");
      const removedBlocker = yield* controls
        .update(project, {
          id: task.id,
          expectedRevision: task.revision,
          state: "done",
          remainingWork: null,
          associations: task.associations.filter((link) => link.kind !== "session"),
        })
        .pipe(Effect.flip);
      expect(removedBlocker.message).toContain("unresolved required sessions");
      f.resolved.add(root);
      yield* completeLinked(project);
      task = yield* todos.read(project, task.id);
      expect(task).toMatchObject({
        state: "done",
        needsAttention: false,
        attentionReason: "Review the final outcome",
        completion: { by: "sessions" },
      });
      expect(task).not.toHaveProperty("remainingWork");
      expect(task.associations).toHaveLength(3);
      expect((yield* todos.list(project)).items).toHaveLength(1);
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect.each(["create", "update", "done", "read", "list"] as const)(
  "%s completes a single resolved session despite remainingWork",
  (access) => {
    const f = fixture();
    return Effect.gen(function* () {
      yield* upsertProject(project, "Project");
      const request = {
        title: "Resolved work",
        description: "Old landing hold is not required work.",
        associations: [link(a)],
        remainingWork: "Owning project is unavailable; fresh readiness required",
      };
      let task;
      if (access === "create") {
        f.resolved.add(a);
        task = yield* controls.create(project, request);
      } else {
        task = yield* todos.create(project, request);
        f.resolved.add(a);
        if (access === "update" || access === "done")
          task = yield* controls.update(project, {
            id: task.id,
            expectedRevision: task.revision,
            ...(access === "done" ? { state: "done" as const } : { status: "Still held" }),
          });
        else if (access === "read") task = yield* controls.read(project, task.id);
        else {
          yield* controls.list(project, { state: "done" });
          task = yield* todos.read(project, task.id);
        }
      }
      expect(task.state).toBe("done");
      expect(task.remainingWork).toBeUndefined();
      const writes = f.reads.writes;
      yield* completeLinked(project);
      expect(f.reads.writes).toBe(writes);
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect(
  "retained resolution closes global stale work without an owning project or checkout",
  () => {
    const f = fixture();
    return Effect.gen(function* () {
      const item = yield* todos.create(CAKE_CHAT_TODO_SCOPE, {
        title: "Unavailable owner",
        description: "Persisted required session outlives its project and worktree.",
        associations: [link(a)],
        remainingWork: "Landing hold",
      });
      f.resolved.add(a);
      expect(yield* controls.read(CAKE_CHAT_TODO_SCOPE, item.id)).toMatchObject({
        state: "done",
        completion: { by: "sessions" },
      });
      expect(f.reads.identities).toBe(0);
      const writes = f.reads.writes;
      yield* controls.list(CAKE_CHAT_TODO_SCOPE, {});
      expect(f.reads.writes).toBe(writes);
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect(
  "standalone remaining work still blocks agent completion, not explicit human completion",
  () => {
    const f = fixture();
    return Effect.gen(function* () {
      yield* upsertProject(project, "Project");
      const item = yield* controls.create(project, {
        title: "Standalone decision",
        description: "No required sessions.",
        remainingWork: "Review the findings",
      });
      yield* completeLinked(project);
      expect((yield* todos.read(project, item.id)).state).toBe("open");
      const denied = yield* controls
        .update(project, {
          id: item.id,
          expectedRevision: item.revision,
          state: "done",
        })
        .pipe(Effect.flip);
      expect(denied.message).toContain("remaining work");
      yield* todos.mutateUser(project, {
        _tag: "SetState",
        id: item.id,
        expectedRevision: item.revision,
        state: "done",
      });
      expect((yield* todos.read(project, item.id)).completion?.by).toBe("user");
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect.each([project, CAKE_CHAT_TODO_SCOPE])(
  "clearing a satisfied hold still waits for every required session in %s",
  (scope) => {
    const f = fixture();
    return Effect.gen(function* () {
      yield* upsertProject(project, "Project");
      let task = yield* controls.create(scope, {
        title: "Reviewed outcome",
        description: "Review complete; second session still active.",
        associations: [link(a), link(b)],
        remainingWork: "Independent review",
        needsAttention: true,
        attentionReason: "Review final evidence",
      });
      f.resolved.add(a);
      task = yield* controls.update(scope, {
        id: task.id,
        expectedRevision: task.revision,
        remainingWork: null,
      });
      yield* completeLinked(scope);
      expect(yield* controls.read(scope, task.id)).toMatchObject({
        state: "open",
        needsAttention: true,
        sessions: [
          { sessionId: a, resolved: true },
          { sessionId: b, resolved: false },
        ],
      });
      f.resolved.add(b);
      yield* completeLinked(scope);
      // A child’s own archive entry cannot bypass its unresolved family root.
      expect((yield* todos.read(scope, task.id)).state).toBe("open");
      f.resolved.add(root);
      yield* completeLinked(scope);
      expect(yield* todos.read(scope, task.id)).toMatchObject({
        state: "done",
        needsAttention: false,
        completion: { by: "sessions" },
      });
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect(
  "remainingWork never substitutes for required-session blockers and explicit human completion remains available",
  () => {
    const f = fixture();
    return Effect.gen(function* () {
      yield* upsertProject(project, "Project");
      let task = yield* controls.create(project, {
        title: "Outcome",
        description: "Work remains.",
        associations: [link(a)],
        remainingWork: "Implementation",
      });
      task = yield* controls.update(project, {
        id: task.id,
        expectedRevision: task.revision,
        remainingWork: null,
      });
      yield* completeLinked(project);
      expect((yield* todos.read(project, task.id)).state).toBe("open");
      // Storage's user commit is still available after the human workflow has resolved blockers.
      f.resolved.add(a);
      task = yield* todos.update(project, {
        id: task.id,
        expectedRevision: task.revision,
        remainingWork: "Follow-up decision",
      });
      yield* todos.mutateUser(project, {
        _tag: "SetState",
        id: task.id,
        expectedRevision: task.revision,
        state: "done",
      });
      expect((yield* todos.read(project, task.id)).completion?.by).toBe("user");
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect(
  "agent mutations canonicalize suffixes before enforcing ownership, including resolved owners",
  () => {
    const f = fixture();
    return Effect.gen(function* () {
      yield* upsertProject(project, "Project");
      f.resolved.add(a);
      const owner = yield* controls.create(project, {
        title: "Owner",
        description: "Resolved work.",
        associations: [link("00000011")],
      });
      expect(owner.state).toBe("done");
      expect(owner.associations).toEqual([link(a)]);
      const duplicate = yield* controls
        .create(CAKE_CHAT_TODO_SCOPE, {
          title: "Duplicate",
          description: "Must not be saved.",
          associations: [link("00000011")],
        })
        .pipe(Effect.flip);
      expect(duplicate.message).toContain(owner.id);
      const target = yield* todos.create(project, {
        title: "Other",
        description: "Keep unrelated work.",
      });
      const conflict = yield* controls
        .update(project, {
          id: target.id,
          expectedRevision: 0,
          associations: [link("00000011")],
        })
        .pipe(Effect.flip);
      expect(conflict.message).toContain(owner.id);
      expect((yield* todos.read(project, target.id)).associations).toEqual([]);
      yield* controls.update(project, {
        id: owner.id,
        expectedRevision: owner.revision,
        associations: [link("00000011")],
      });
      expect((yield* todos.read(project, owner.id)).revision).toBe(owner.revision);
      expect((yield* todos.list(CAKE_CHAT_TODO_SCOPE)).items).toEqual([]);
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect("linked session resolution clears selection without selecting other open work", () => {
  const f = fixture();
  return Effect.gen(function* () {
    yield* upsertProject(project, "Project");
    const selected = yield* todos.create(project, {
      title: "Linked work",
      description: "Awaiting resolution.",
      associations: [link(a)],
    });
    const other = yield* todos.create(project, {
      title: "Other open work",
      description: "Still needs review.",
      needsAttention: true,
      attentionReason: "Review the findings",
    });
    yield* todos.mutateUser(project, { _tag: "Select", selectedId: selected.id });
    f.resolved.add(a);
    yield* completeLinked(project);
    expect((yield* todos.read(project, selected.id)).completion?.by).toBe("sessions");
    expect((yield* todos.list(project)).selectedId).toBeNull();
    expect(yield* todos.read(project, other.id)).toEqual(other);
    yield* completeLinked(project);
    expect((yield* todos.list(project)).selectedId).toBeNull();
    yield* todos.mutateUser(project, { _tag: "Select", selectedId: other.id });
    expect((yield* todos.list(project)).selectedId).toBe(other.id);
  }).pipe(Effect.provide(f.layer));
});

it.effect.each([false, true])(
  "validates public subagent handles, parent and project ownership without acquiring workers (released=%s)",
  (released) => {
    const f = released
      ? fixture([], [subagentHistoryFixture({ ...worker, sessionDirectory: "/private-sessions" })])
      : fixture([worker]);
    return Effect.gen(function* () {
      yield* upsertProject(project, "Project");
      const association = {
        kind: "subagent" as const,
        parentSessionId: "00000011",
        handleId: worker.handleId,
        title: "Investigation worker",
      };
      const item = yield* controls.create(project, {
        title: "Investigate",
        description: "Review the findings.",
        associations: [association],
      });
      expect(item.associations).toEqual([{ ...association, parentSessionId: a }]);
      const ref = subagentLink(a, worker.handleId);
      expect(parseSubagentLink(ref)).toEqual({ parentSessionId: a, handleId: worker.handleId });
      expect(parseSubagentLink(subagentLink(a, worker.privateSessionId))).toBeUndefined();
      const source = yield* controls.update(project, {
        id: item.id,
        expectedRevision: 0,
        associations: [
          association,
          {
            kind: "source",
            ref: subagentLink("00000011", worker.handleId),
            title: "Worker report",
          },
        ],
      });
      expect(source.associations[1]).toEqual({ kind: "source", ref, title: "Worker report" });
      for (const bad of [
        { ...association, parentSessionId: b },
        { ...association, handleId: SubagentHandleId.make("10000000-0000-4000-8000-000000000099") },
        { ...association, handleId: worker.privateSessionId },
      ]) {
        expect(
          (yield* controls
            .create(project, { title: "Bad", description: "Invalid.", associations: [bad] })
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
      }
      yield* upsertProject("/other", "Other");
      expect(
        (yield* controls
          .create("/other", {
            title: "Bad project",
            description: "Invalid.",
            associations: [association],
          })
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
      // A complete report is not resolution. Mixed work retains existing session closure semantics.
      yield* completeLinked(project);
      expect((yield* todos.read(project, item.id)).state).toBe("open");
      const mixed = yield* todos.create(project, {
        title: "Mixed work",
        description: "Review.",
        associations: [{ ...association, parentSessionId: a }, link(a)],
      });
      f.resolved.add(a);
      yield* completeLinked(project);
      expect((yield* todos.read(project, mixed.id)).state).toBe("done");
      expect((yield* todos.read(project, item.id)).state).toBe("open");
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect(
  "Cake tools accept subagent associations and return canonical identities while rejecting private IDs",
  () => {
    const f = fixture([worker]);
    return Effect.gen(function* () {
      yield* upsertProject(project, "Project");
      const context = yield* Effect.context<Layer.Success<typeof f.layer>>();
      const run = <A, E>(effect: Effect.Effect<A, E, Layer.Success<typeof f.layer>>) =>
        Effect.runPromise(effect.pipe(Effect.provide(context)));
      const registry = new CakeOperationRegistry(
        createProjectTodoOperations({
          select: (input) => run(todos.mutateUser(project, { _tag: "Select", ...input })),
          list: (input) => run(controls.list(project, input)),
          read: (id) => run(controls.read(project, id)),
          create: (input) => run(controls.create(project, input)),
          update: (input) => run(controls.update(project, input)),
          updateMany: (input) => run(controls.updateMany(project, input)),
        }),
      );
      const execute = (handleId: string) =>
        registry.invoke(
          {
            command: "todos.create",
            input: {
              title: "Review worker",
              description: "Review the report.",
              detail: true,
              associations: [
                { kind: "subagent", parentSessionId: "00000011", handleId, title: "Investigator" },
              ],
            },
          },
          { signal: new AbortController().signal, toolCallId: "test", runtime: {} },
        );
      const result = yield* Effect.promise(() => execute(worker.handleId));
      expect(JSON.stringify(result.structuredContent)).toContain(`"parentSessionId":"${a}"`);
      expect(JSON.stringify(result.structuredContent)).toContain('"kind":"subagent"');
      expect(
        (yield* Effect.tryPromise(() => execute(worker.privateSessionId)).pipe(Effect.result))._tag,
      ).toBe("Failure");
      expect((yield* todos.list(project)).items).toHaveLength(1);
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect(
  "list access repairs its scope and joined pages use metadata only, without content or runtime inspection",
  () => {
    const f = fixture();
    return Effect.gen(function* () {
      yield* upsertProject(project, "Project");
      // A legacy list may contain repeated links; reads must remain bounded and usable.
      for (let n = 0; n < 30; n++)
        yield* seedHistoricalTodo(project, {
          title: `Task ${n}`,
          description: "PRIVATE_BRIEF",
          status: "PRIVATE_PROGRESS",
          associations: [
            link(a),
            link(b),
            {
              kind: "source",
              ref: `cake://session/${b}?message=report`,
              title: "PRIVATE_REPORT_TITLE",
            },
            { kind: "source", ref: "https://example.com", title: "Context" },
          ],
        });
      f.resolved.add(a);
      f.resolved.add(b); // A child's own index bit is not its authority.
      const before = { ...f.reads };
      const cheap = yield* controls.list(project, { state: "open", query: "Task", limit: 2 });
      expect(cheap.items[0]).toEqual({
        id: expect.any(String),
        title: "Task 0",
        needsAttention: false,
        revision: 0,
        state: "open",
      });
      expect(f.reads).toEqual({
        ...before,
        index: before.index + 1,
        family: before.family + 1,
        identities: before.identities + 1,
      });
      const beforePage = { ...f.reads };
      const page = yield* controls.list(project, {
        state: "open",
        view: "reconciliation",
        limit: 20,
      });
      expect(Schema.is(ProjectTodoList)(page)).toBe(true);
      expect(page).toMatchObject({ total: 30, nextOffset: 20 });
      expect(f.reads.index - beforePage.index).toBe(2);
      expect(f.reads.family - beforePage.family).toBe(2);
      expect(f.reads.identities - beforePage.identities).toBe(2);
      expect(JSON.stringify(page)).not.toContain("PRIVATE_");
      expect(page.items[0]).toMatchObject({
        sessions: [
          { sessionId: a, resolved: true },
          { sessionId: b, resolved: false },
        ],
      });
      f.resolved.add(root);
      const detail = yield* controls.read(project, page.items[0]?.id ?? "");
      expect(detail).toMatchObject({
        description: "PRIVATE_BRIEF",
        status: "PRIVATE_PROGRESS",
        sessions: [
          { sessionId: a, resolved: true },
          { sessionId: b, resolved: true },
        ],
      });
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect(
  "honors caller-selected to-do page sizes through the tool and backend without changing defaults, filters or scope",
  () => {
    const f = fixture();
    return Effect.gen(function* () {
      yield* upsertProject(project, "Project");
      const active = yield* Effect.forEach(
        Array.from({ length: 130 }, (_, n) => n),
        (n) => todos.create(project, { title: `Task ${n}`, description: "Work." }),
      );
      yield* todos.create(project, {
        title: "Task attention",
        description: "Work.",
        needsAttention: true,
        attentionReason: "Review this.",
      });
      const snoozed = yield* todos.create(project, { title: "Task snoozed", description: "Work." });
      yield* todos.mutateUser(project, {
        _tag: "Snooze",
        id: snoozed.id,
        expectedRevision: 0,
        until: "2099-01-01T00:00:00.000Z",
      });
      const done = yield* todos.create(project, { title: "Task done", description: "Work." });
      yield* todos.mutateUser(project, {
        _tag: "SetState",
        id: done.id,
        expectedRevision: 0,
        state: "done",
      });
      yield* todos.create(project, { title: "Other work", description: "Work." });
      yield* upsertProject("/other", "Other");
      yield* todos.create("/other", { title: "Task other project", description: "Work." });
      yield* todos.create(CAKE_CHAT_TODO_SCOPE, { title: "Task global", description: "Work." });

      const defaults = yield* controls.list(project, {});
      expect(defaults).toMatchObject({ total: 134, offset: 0, nextOffset: 20 });
      expect(defaults.items.map((item) => item.id)).toEqual(
        active.slice(0, 20).map((item) => item.id),
      );
      for (const view of ["summary", "reconciliation"] as const) {
        for (const limit of [51, 100, 125]) {
          const page = yield* controls.list(project, { view, limit });
          expect(page.items.map((item) => item.id)).toEqual(
            active.slice(0, limit).map((item) => item.id),
          );
          expect(page).toMatchObject({ total: 134, offset: 0, nextOffset: limit });
          expect(Schema.is(ProjectTodoList)(page)).toBe(true);
          if (view === "reconciliation")
            expect(page.items.every((item) => "sessions" in item)).toBe(true);
        }
      }
      const filter = { query: "tAsK", state: "open", category: "active" } as const;
      const filtered = yield* controls.list(project, { ...filter, limit: 100, offset: 30 });
      expect(filtered.items.map((item) => item.id)).toEqual(
        active.slice(30).map((item) => item.id),
      );
      expect(filtered).toMatchObject({ total: 130, offset: 30, nextOffset: null });
      expect(yield* controls.list(project, { ...filter, limit: 100, offset: 130 })).toEqual({
        items: [],
        total: 130,
        offset: 130,
        nextOffset: null,
      });
      expect(
        (yield* controls.list(project, { state: "open", limit: Number.MAX_SAFE_INTEGER })).items,
      ).toHaveLength(133);
      expect(
        (yield* controls.list(project, { state: "done", limit: 100 })).items.map((item) => item.id),
      ).toEqual([done.id]);
      expect(
        (yield* controls.list(project, { category: "snoozed", limit: 100 })).items.map(
          (item) => item.id,
        ),
      ).toEqual([snoozed.id]);
      expect((yield* controls.list("/unregistered", { limit: 100 }).pipe(Effect.result))._tag).toBe(
        "Failure",
      );

      const context = yield* Effect.context<Layer.Success<typeof f.layer>>();
      const unused = async () => {
        throw Error("Only list should be called");
      };
      const registry = new CakeOperationRegistry(
        createProjectTodoOperations({
          select: unused,
          read: unused,
          create: unused,
          update: unused,
          updateMany: unused,
          list: (input) =>
            Effect.runPromise(controls.list(project, input).pipe(Effect.provide(context))),
        }),
      );
      const result = yield* Effect.tryPromise(() =>
        registry.invoke(
          { command: "todos.list", input: { limit: 100 } },
          { signal: new AbortController().signal, toolCallId: "list-100", runtime: {} },
        ),
      );
      const { result: page } = Schema.decodeUnknownSync(
        Schema.Struct({ command: Schema.Literal("todos.list"), result: ProjectTodoList }),
      )(result.structuredContent);
      expect(page.items.map((item) => item.id)).toEqual(
        active.slice(0, 100).map((item) => item.id),
      );
      expect(page).toMatchObject({ total: 134, nextOffset: 100 });
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect(
  "atomic bulk updates use one commit, preserve input order, and stale backfill cannot clobber a concurrent reopen",
  () => {
    const f = fixture();
    return Effect.gen(function* () {
      yield* upsertProject(project, "Project");
      const first = yield* todos.create(project, { title: "First", description: "Work." });
      const second = yield* todos.create(project, { title: "Second", description: "Work." });
      const page = yield* controls.list(project, { state: "open", view: "reconciliation" });
      const before = f.reads.writes;
      const committed = yield* controls.updateMany(
        project,
        [second, first].map((item) => ({
          id: item.id,
          expectedRevision: 0,
          state: "done" as const,
        })),
      );
      expect(committed.map((item) => item.id)).toEqual([second.id, first.id]);
      expect(f.reads.writes - before).toBe(1);
      yield* todos.mutateUser(project, {
        _tag: "SetState",
        id: first.id,
        expectedRevision: 1,
        state: "open",
      });
      const writes = f.reads.writes;
      const conflict = yield* Effect.flip(
        controls.updateMany(project, [
          { id: second.id, expectedRevision: 1, status: "Must not commit" },
          { id: first.id, expectedRevision: page.items[0]?.revision ?? 0, state: "done" },
        ]),
      );
      expect(conflict.message).toContain(`to-do ${first.id} changed (current revision 2)`);
      expect(f.reads.writes).toBe(writes);
      expect((yield* todos.read(project, second.id)).status).toBe("");
      expect((yield* todos.read(project, first.id)).state).toBe("open");
      const candidate = yield* todos.read(project, first.id);
      yield* todos.update(project, { id: first.id, expectedRevision: 2, status: "New intent" });
      yield* todos.completeResolved(project, [candidate]);
      expect((yield* todos.read(project, first.id)).state).toBe("open");
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect.each([project, CAKE_CHAT_TODO_SCOPE])(
  "list access repairs only %s before applying state filters and remains idempotent",
  (scope) => {
    const f = fixture();
    return Effect.gen(function* () {
      yield* upsertProject(project, "Project");
      yield* upsertProject("/other", "Other");
      const item = yield* todos.create(scope, {
        title: "Interrupted reconciliation",
        description: "Resolved while Cake was closed.",
        associations: [link(a)],
        remainingWork: "Landing hold; stale readiness requires owning project",
      });
      const other = yield* todos.create("/other", {
        title: "Do not sweep me",
        description: "Only this list's own access may repair it.",
        associations: [link(root)],
      });
      f.resolved.add(a);
      f.resolved.add(root);
      const before = { ...f.reads };
      expect((yield* todos.read(scope, item.id)).state).toBe("open");
      expect(f.reads).toEqual(before); // Reading stored projections never starts a repair.
      const done = yield* controls.list(scope, { category: "done", limit: 1 });
      expect(done).toMatchObject({ total: 1, nextOffset: null });
      expect(done.items[0]).toMatchObject({ id: item.id, state: "done", revision: 1 });
      expect((yield* todos.read("/other", other.id)).state).toBe("open");
      const writes = f.reads.writes;
      expect((yield* controls.list(scope, { state: "open" })).items).toEqual([]);
      expect(f.reads.writes).toBe(writes);
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect(
  "detail access repairs only the requested item, not other stale items in its list",
  () => {
    const f = fixture();
    return Effect.gen(function* () {
      yield* upsertProject(project, "Project");
      const item = yield* todos.create(project, {
        title: "Read me",
        description: "Resolved while Cake was closed.",
        associations: [link(a)],
        remainingWork: "Stale readiness; fresh readiness required",
      });
      const other = yield* todos.create(project, {
        title: "Not accessed",
        description: "Leave alone.",
        associations: [link(root)],
      });
      f.resolved.add(a);
      f.resolved.add(root);
      expect(yield* controls.read(project, item.id)).toMatchObject({
        id: item.id,
        state: "done",
        revision: 1,
        sessions: [{ sessionId: a, resolved: true }],
      });
      expect((yield* todos.read(project, other.id)).state).toBe("open");
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect.each(["create", "edit", "done", "batch"] as const)(
  "%s returns a persisted receipt while unrelated linked-work reconciliation is suspended",
  (operation) => {
    const f = fixture();
    return Effect.gen(function* () {
      yield* upsertProject(project, "Project");
      yield* todos.create(project, {
        title: "Unrelated linked work",
        description: "Resolved by the independent lifecycle hook.",
        associations: [link(a)],
      });
      const item = yield* todos.create(project, { title: "Cheap", description: "Metadata only." });
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const archive = yield* SessionArchiveStorage;
      const reconciliation = yield* completeLinked(project).pipe(
        Effect.provideService(SessionArchiveStorage, {
          ...archive,
          resolutionSnapshot: () =>
            Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.andThen(archive.resolutionSnapshot()),
            ),
        }),
        Effect.forkChild,
      );
      yield* Deferred.await(entered);
      const writes = f.reads.writes;
      const update = { id: item.id, expectedRevision: 0, status: "Committed" };
      const mutation =
        operation === "create"
          ? controls.create(project, { title: "New", description: "Metadata only." })
          : operation === "batch"
            ? controls.updateMany(project, [update]).pipe(Effect.map((items) => items[0]))
            : controls.update(project, {
                ...update,
                ...(operation === "done" ? { state: "done" as const } : {}),
              });
      // A second resolution read is unrelated to this mutation. Fail immediately instead
      // of using a wall-clock timeout if the operation incorrectly depends on that work.
      const result = yield* mutation.pipe(
        Effect.provideService(SessionArchiveStorage, {
          ...archive,
          resolutionSnapshot: () => Effect.die("Cheap mutation waited on unrelated resolution"),
        }),
      );
      expect(result).toBeDefined();
      if (!result) throw new Error("Missing committed item");
      expect(f.reads.writes).toBe(writes + 1);
      expect(yield* todos.read(project, result.id)).toEqual(result);
      expect(yield* Deferred.isDone(release)).toBe(false);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(reconciliation);
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect("a resolution racing a mutation's commit is rechecked only for the edited item", () => {
  const f = fixture();
  return Effect.gen(function* () {
    yield* upsertProject(project, "Project");
    const item = yield* todos.create(project, {
      title: "Edited work",
      description: "Must not miss resolution.",
      associations: [link(a)],
    });
    const unrelated = yield* todos.create(project, {
      title: "Other work",
      description: "Owned by lifecycle reconciliation.",
      associations: [link(b)],
    });
    const archive = yield* SessionArchiveStorage;
    const updated = yield* controls
      .update(project, {
        id: item.id,
        expectedRevision: 0,
        status: "Committed",
      })
      .pipe(
        Effect.provideService(SessionArchiveStorage, {
          ...archive,
          resolutionSnapshot: () =>
            archive.resolutionSnapshot().pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  // The first join captured unresolved. Resolution commits before the to-do write.
                  f.resolved.add(a);
                  f.resolved.add(root);
                }),
              ),
            ),
        }),
      );
    expect(updated).toMatchObject({
      state: "done",
      status: "Committed",
      completion: { by: "sessions" },
    });
    expect(yield* todos.read(project, item.id)).toEqual(updated);
    expect((yield* todos.read(project, unrelated.id)).state).toBe("open");
    yield* completeLinked(project);
    expect((yield* todos.read(project, unrelated.id)).state).toBe("done");
  }).pipe(Effect.provide(f.layer));
});

it.effect("a reopen during the metadata join wins over automatic completion", () => {
  const f = fixture();
  return Effect.gen(function* () {
    yield* upsertProject(project, "Project");
    const item = yield* todos.create(project, {
      title: "Work",
      description: "Work.",
      associations: [link(a)],
    });
    const joined = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const archive = yield* SessionArchiveStorage;
    f.resolved.add(a);
    const fiber = yield* completeLinked(project).pipe(
      Effect.provideService(SessionArchiveStorage, {
        ...archive,
        resolutionSnapshot: () =>
          archive.resolutionSnapshot().pipe(
            Effect.tap(() => Deferred.succeed(joined, undefined)),
            Effect.tap(() => Deferred.await(release)),
          ),
      }),
      Effect.forkChild,
    );
    yield* Deferred.await(joined);
    yield* todos.update(project, { id: item.id, expectedRevision: 0, state: "open" });
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(fiber);
    expect(yield* todos.read(project, item.id)).toMatchObject({
      state: "open",
      revision: 1,
    });
  }).pipe(Effect.provide(f.layer));
});

it.effect(
  "unknown links never auto-close and session sources deduplicate canonical identities",
  () => {
    const f = fixture();
    return Effect.gen(function* () {
      yield* upsertProject(project, "Project");
      const item = yield* todos.create(project, {
        title: "Unknown",
        description: "Work.",
        associations: [
          link(a),
          link("missing"),
          { kind: "source", ref: `cake://session/${a}?message=report`, title: "Report" },
        ],
      });
      f.resolved.add(a);
      const [result] = yield* join(project, [item]);
      expect(result?.sessions).toEqual([
        { sessionId: a, resolved: true },
        { sessionId: "missing", resolved: null, reason: expect.any(String) },
      ]);
      yield* completeLinked(project);
      expect((yield* todos.read(project, item.id)).state).toBe("open");
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect.each([project, CAKE_CHAT_TODO_SCOPE])(
  "resolved sessions complete snoozed items in %s and expiry never resurrects them",
  (scope) => {
    const f = fixture();
    return Effect.gen(function* () {
      yield* upsertProject(project, "Project");
      const item = yield* todos.create(scope, {
        title: "Work",
        description: "Work.",
        associations: [link(a)],
      });
      const snoozed = yield* controls.update(scope, {
        id: item.id,
        expectedRevision: 0,
        snoozedUntil: "1970-01-01T00:15:00.000Z",
      });
      expect(snoozed.state).toBe("open");
      f.resolved.add(a);
      yield* completeLinked(scope);
      const done = yield* todos.read(scope, item.id);
      expect(done).toMatchObject({ state: "done", completion: { by: "sessions" } });
      expect(done).not.toHaveProperty("snoozedUntil");
      yield* TestClock.setTime(1_800_000);
      yield* snoozes.initialize();
      expect(yield* todos.read(scope, item.id)).toEqual(done);
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect("expiry repairs a linked resolution join racing the deadline revision", () => {
  const f = fixture();
  return Effect.gen(function* () {
    yield* upsertProject(project, "Project");
    const item = yield* todos.create(project, {
      title: "Work",
      description: "Work.",
      associations: [link(a)],
    });
    yield* todos.update(project, {
      id: item.id,
      expectedRevision: 0,
      snoozedUntil: "1970-01-01T00:15:00.000Z",
    });
    f.resolved.add(a);
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const archive = yield* SessionArchiveStorage;
    const reconciliation = yield* completeLinked(project).pipe(
      Effect.provideService(SessionArchiveStorage, {
        ...archive,
        resolutionSnapshot: () =>
          archive.resolutionSnapshot().pipe(
            Effect.tap(() => Deferred.succeed(entered, undefined)),
            Effect.tap(() => Deferred.await(release)),
          ),
      }),
      Effect.forkChild,
    );
    yield* Deferred.await(entered);
    yield* TestClock.setTime(900_000);
    yield* snoozes.initialize();
    expect(yield* todos.read(project, item.id)).toMatchObject({
      state: "done",
      completion: { by: "sessions" },
    });
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(reconciliation);
    expect(yield* todos.read(project, item.id)).not.toHaveProperty("snoozedUntil");
    expect((yield* todos.read(project, item.id)).state).toBe("done");
  }).pipe(Effect.provide(f.layer));
});

it.effect(
  "snoozing work whose session is already resolved returns completion, not a new deadline",
  () => {
    const f = fixture();
    return Effect.gen(function* () {
      yield* upsertProject(project, "Project");
      const item = yield* todos.create(project, {
        title: "Work",
        description: "Work.",
        associations: [link(a)],
      });
      f.resolved.add(a);
      const updated = yield* controls.update(project, {
        id: item.id,
        expectedRevision: 0,
        snoozedUntil: "1970-01-01T00:15:00.000Z",
      });
      expect(updated).toMatchObject({ state: "done", completion: { by: "sessions" } });
      expect(updated).not.toHaveProperty("snoozedUntil");
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect(
  "production operation registry returns compact receipts, opt-in detail and ordered atomic batch receipts",
  () => {
    const f = fixture();
    return Effect.gen(function* () {
      yield* upsertProject(project, "Project");
      const context = yield* Effect.context<ApplicationState>();
      const run = <A, E>(effect: Effect.Effect<A, E, ApplicationState>) =>
        Effect.runPromise(effect.pipe(Effect.provide(context)));
      const control: ProjectTodoControl = {
        select: (input) =>
          run(
            todos
              .mutateUser(project, { _tag: "Select", ...input })
              .pipe(Effect.map(({ selectedId }) => ({ selectedId }))),
          ),
        list: (input) =>
          run(
            todos.list(project).pipe(
              Effect.map((value) => ({
                items: value.items.map(({ id, title, state, revision }) => ({
                  id,
                  title,
                  state,
                  needsAttention: false,
                  revision,
                })),
                offset: input.offset ?? 0,
                total: value.items.length,
                nextOffset: null,
              })),
            ),
          ),
        read: (id) =>
          run(todos.read(project, id).pipe(Effect.map((item) => ({ ...item, sessions: [] })))),
        create: (input) => run(todos.create(project, input)),
        update: (input) => run(todos.update(project, input)),
        updateMany: (input) => run(todos.updateMany(project, input)),
      };
      const registry = new CakeOperationRegistry(createProjectTodoOperations(control));
      const execution = { signal: new AbortController().signal, toolCallId: "test", runtime: {} };
      const call = (command: string, input: unknown) =>
        Effect.promise(() => registry.invoke({ command, input }, execution));
      const created = yield* call("todos.create", { title: "Task", description: "PRIVATE_BRIEF" });
      const items = (yield* todos.list(project)).items;
      const id = items[0]?.id;
      expect(created.structuredContent).toEqual({
        command: "todos.create",
        result: { id, revision: 0, committed: true, needsAttention: false },
      });
      const updated = yield* call("todos.update", {
        id,
        expectedRevision: 0,
        status: "PRIVATE_PROGRESS",
      });
      expect(updated.structuredContent).toEqual({
        command: "todos.update",
        result: { revision: 1, committed: true, needsAttention: false },
      });
      expect(updated.text.length).toBeLessThan(90);
      const detailed = yield* call("todos.update", {
        id,
        expectedRevision: 1,
        status: "PRIVATE_PROGRESS",
        detail: true,
      });
      expect(JSON.stringify(detailed.structuredContent)).toContain("PRIVATE_BRIEF");
      const batch = yield* call("todos.update-many", {
        updates: [{ id, expectedRevision: 2, state: "done" }],
      });
      expect(batch.structuredContent).toEqual({
        command: "todos.update-many",
        result: { receipts: [{ revision: 3, committed: true, needsAttention: false }] },
      });
      expect(registry.help()).toContain("todos");
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect(
  "global Cake Chat keeps its own list, links work in any project and closes it on resolution",
  () => {
    const f = fixture([worker]);
    return Effect.gen(function* () {
      yield* upsertProject(project, "Project");
      yield* upsertProject("/other", "Other");
      // A worker owned by a Project is accepted in the global list with its canonical parent.
      const reviewed = yield* controls.create(CAKE_CHAT_TODO_SCOPE, {
        title: "Review worker",
        description: "Review the worker report.",
        associations: [
          {
            kind: "subagent",
            parentSessionId: "00000011",
            handleId: worker.handleId,
            title: "Investigator",
          },
        ],
      });
      expect(reviewed.associations[0]).toMatchObject({ kind: "subagent", parentSessionId: a });
      const child = yield* todos.create(CAKE_CHAT_TODO_SCOPE, {
        title: "Child work",
        description: "Finish the child session.",
        associations: [link(b)],
      });
      // Historical cross-list duplicates still reconcile without discarding data.
      const elsewhere = yield* seedHistoricalTodo("/other", {
        title: "Not this project's family",
        description: "A Project list only counts its own families.",
        associations: [link(b)],
      });
      expect((yield* todos.list(project)).items).toEqual([]);
      expect((yield* controls.list(CAKE_CHAT_TODO_SCOPE, {})).items.map((i) => i.title)).toEqual([
        "Review worker",
        "Child work",
      ]);

      // Resolving the family root in /project closes the global item, not a foreign Project's.
      f.resolved.add(root);
      yield* completeLinkedForProject(project);
      yield* completeLinked("/other");
      expect((yield* todos.read(CAKE_CHAT_TODO_SCOPE, child.id)).completion?.by).toBe("sessions");
      expect((yield* todos.read(CAKE_CHAT_TODO_SCOPE, reviewed.id)).state).toBe("open");
      expect((yield* todos.read("/other", elsewhere.id)).state).toBe("open");

      // The global list hears lifecycle changes only for sessions it links.
      const sessionChanges = (scope: string) =>
        todos
          .list(scope)
          .pipe(
            Effect.map((value) =>
              value.pending.flatMap((entry) =>
                entry._tag === "SessionState" ? [entry.sessionId] : [],
              ),
            ),
          );
      yield* recordLifecycle(project, a, true);
      yield* recordLifecycle(project, b, true);
      expect(yield* sessionChanges(project)).toEqual([a, b]);
      expect(yield* sessionChanges(CAKE_CHAT_TODO_SCOPE)).toEqual([b]);

      // Its user-change reminder is labelled for Cake Chat and stays an application boundary.
      const prepared = yield* todos.prepareForChat(CAKE_CHAT_SESSION_ID, "Continue");
      expect(prepared.text.startsWith("<system-reminder>\nCake Chat user changes.")).toBe(true);
      expect(splitProjectTodoReminder(prepared.text).text).toBe("Continue");
    }).pipe(Effect.provide(f.layer));
  },
);
