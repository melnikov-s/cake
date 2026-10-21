import { it } from "@effect/vitest";
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
import { completeLinked, join } from "../../../src/domain/projects/projectTodoResolution";
import { createProjectTodoOperations } from "../../../src/domain/projects/project-todo-operations";
import { CakeOperationRegistry } from "../../../src/services/pi/runtime/cake-operation-registry";
import {
  ProjectTodoList,
  type ProjectTodoControl,
} from "../../../src/contracts/projects/project-todos";

const project = "/project";
const a = "00000000-0000-4000-8000-000000000011";
const b = "00000000-0000-4000-8000-000000000022";
const root = "00000000-0000-4000-8000-000000000033";
const directory = sessionDirectoryPath({ workingDirectory: project, root: "/sessions" });
const link = (sessionId: string) => ({ kind: "session" as const, sessionId, title: "Work" });

function fixture() {
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
    Layer.mock(SessionArchiveStorage, {
      resolutionSnapshot: () =>
        Effect.sync(() => {
          reads.index++;
          return { version: 1 as const, directories: { [directory]: [...resolved] } };
        }),
    }),
    Layer.mock(SessionFamilyStorage, {
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

it.effect(
  "one bounded joined page reads one lifecycle index/family snapshot, no per-item content or runtime inspection",
  () => {
    const f = fixture();
    return Effect.gen(function* () {
      yield* upsertProject(project, "Project");
      for (let n = 0; n < 30; n++)
        yield* todos.create(project, {
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
        revision: 0,
        state: "open",
      });
      expect(f.reads).toEqual(before);
      const page = yield* controls.list(project, {
        state: "open",
        view: "reconciliation",
        limit: 20,
      });
      expect(Schema.is(ProjectTodoList)(page)).toBe(true);
      expect(page).toMatchObject({ total: 30, nextOffset: 20 });
      expect(f.reads.index - before.index).toBe(1);
      expect(f.reads.family - before.family).toBe(1);
      expect(f.reads.identities - before.identities).toBe(1);
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
        list: (input) =>
          run(
            todos.list(project).pipe(
              Effect.map((value) => ({
                items: value.items.map(({ id, title, state, revision }) => ({
                  id,
                  title,
                  state,
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
        result: { id, revision: 0, committed: true },
      });
      const updated = yield* call("todos.update", {
        id,
        expectedRevision: 0,
        status: "PRIVATE_PROGRESS",
      });
      expect(updated.structuredContent).toEqual({
        command: "todos.update",
        result: { revision: 1, committed: true },
      });
      expect(updated.text.length).toBeLessThan(60);
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
        result: { receipts: [{ revision: 3, committed: true }] },
      });
      expect(registry.help()).toContain("todos");
    }).pipe(Effect.provide(f.layer));
  },
);
