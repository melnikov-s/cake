import { it } from "@effect/vitest";
import { seedHistoricalTodo } from "../helpers/projectTodoHarness";
import { SubagentCoordinatorLive } from "../../../src/services/subagents/SubagentCoordinator";
import { makeSubagentStorageTestLayer } from "../helpers/subagentStorageFixture";
import { SessionCatalogChanges } from "../../../src/services/session-catalogs/SessionCatalogChanges";
import { expect } from "vitest";
import { Deferred, Effect, Fiber, Layer, Stream } from "effect";
import { createStore, mount } from "r-state-tree";
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
import { completeLinked } from "../../../src/domain/projects/projectTodoResolution";
import { list } from "../../../src/domain/projects/projectTodoAssociations";
import { observeCatalog } from "../../../src/domain/projects/projects";
import { ProjectCatalog } from "../../../src/renderer/models/ProjectCatalog";
import { applyProjectCatalogUpdate } from "../../../src/renderer/reducers/CatalogReducer";
import { ProjectTodosStore } from "../../../src/renderer/stores/ProjectTodosStore";
import { SideChatStore } from "../../../src/renderer/stores/SideChatStore";

const project = "/project";
const a = "00000000-0000-4000-8000-000000000011";
const b = "00000000-0000-4000-8000-000000000022";
const directory = sessionDirectoryPath({ workingDirectory: project, root: "/sessions" });
const link = (sessionId: string) => ({ kind: "session" as const, sessionId, title: "Work" });

function fixture() {
  let state = defaultApplicationState();
  const resolved = new Set<string>();
  const reads = { index: 0, identities: 0, writes: 0 };
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
  const identities = [a, b];
  const metadata = Layer.mergeAll(
    SessionCatalogChanges.layer,
    SubagentCoordinatorLive.pipe(Layer.provide(makeSubagentStorageTestLayer())),
    Layer.mock(SessionArchiveStorage, {
      resolutionSnapshot: () =>
        Effect.sync(() => {
          reads.index++;
          return { version: 1 as const, directories: { [directory]: [...resolved] } };
        }),
    }),
    Layer.mock(SessionFamilyStorage, {
      state: () => Effect.succeed({ families: [], turns: [], spawnedSessions: [] }),
    }),
    Layer.mock(CakeSessionRuntimes, {
      activeWorkingDirectories: () => Effect.succeed([]),
      sessionIds: () =>
        Stream.fromEffect(
          Effect.sync(() => {
            reads.identities++;
            return identities;
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
  return { app, metadata, resolved, identities, reads, persisted: () => state };
}
const create = (sessionIds: string[]) =>
  todos.create(project, {
    title: "Work",
    description: "Implement the requested change.",
    associations: sessionIds.map(link),
  });

it.effect(
  "backfills legacy canonical/suffix links on list access after restart, persists count projection, and remains idempotent without runtimes or wakes",
  () => {
    const f = fixture();
    return Effect.gen(function* () {
      const ids = yield* Effect.gen(function* () {
        yield* upsertProject(project, "Project");
        const canonical = yield* todos.create(project, {
          title: "Stale landing hold",
          description: "Resolved while Cake was closed.",
          remainingWork: "Fresh readiness required; owning project unavailable",
          associations: [link(a)],
        });
        const suffix = yield* seedHistoricalTodo(project, {
          title: "Legacy work",
          description: "Historical suffix link.",
          remainingWork: "Independent review still needed",
          associations: [link("00000011")],
        });
        const source = yield* todos.create(project, {
          title: "Discuss design",
          description: "Review the design, not implementation.",
          associations: [
            { kind: "source", ref: `cake://session/${a}?message=report`, title: "Report" },
          ],
        });
        const closed = yield* create([b]);
        yield* todos.mutateUser(project, {
          _tag: "SetState",
          id: closed.id,
          expectedRevision: 0,
          state: "done",
        });
        yield* todos.mutateUser(project, { _tag: "Select", selectedId: canonical.id });
        return { canonical: canonical.id, suffix: suffix.id, source: source.id, closed: closed.id };
      }).pipe(Effect.provide(f.app, { local: true }));
      f.resolved.add(a);
      f.identities.length = 0; // Retired checkout: only the durable resolution index retains identity.
      yield* Effect.gen(function* () {
        yield* (yield* ApplicationState).initialize();
        using catalog = ProjectCatalog.create({ projects: [] });
        using sidePanel = mount(createStore(SideChatStore, {}));
        using store = mount(
          createStore(ProjectTodosStore, {
            list: () => {
              const owner = catalog.find(project);
              return owner && { scope: project, chat: "Project Chat" as const, owner };
            },
            pane: () => ({
              visible: Boolean(sidePanel.target),
              open: () => {
                throw new Error("Reconciliation must not open a pane");
              },
              close: () => sidePanel.close(),
            }),
            replyContext: () => {},
          }),
        );
        const ready = yield* Deferred.make<void>();
        const updated = yield* Deferred.make<void>();
        const updates = yield* observeCatalog();
        const observer = yield* updates.pipe(
          Stream.runForEach((update) =>
            Effect.gen(function* () {
              applyProjectCatalogUpdate(catalog, update);
              if (store.openItems.length === 3) yield* Deferred.succeed(ready, undefined);
              if (store.openItems.length === 1) yield* Deferred.succeed(updated, undefined);
            }),
          ),
          Effect.forkChild,
        );
        yield* Deferred.await(ready);
        expect(f.reads.index).toBe(0); // Restart and projection observation do not scan links.
        yield* list(project, {}); // Repair is explicitly requested by list access.
        yield* Deferred.await(updated);
        expect(store.openItems.map((item) => item.id)).toEqual([ids.source]);
        expect(store.focusedItems).toEqual([]);
        expect(sidePanel.target).toBeUndefined(); // Reconciliation never opens a pane.
        expect(f.persisted().projects[0]?.todos?.selectedId).toBeNull();
        expect(store.doneItems.map((item) => item.id)).toEqual([
          ids.canonical,
          ids.suffix,
          ids.closed,
        ]);
        expect(
          f.persisted().projects[0]?.todos?.items.filter((item) => item.state === "open"),
        ).toHaveLength(1);
        const writes = f.reads.writes;
        yield* list(project, {});
        expect(f.reads.writes).toBe(writes);
        expect((yield* todos.read(project, ids.closed)).revision).toBe(1); // Explicit closure was not touched.
        const receipt = (yield* todos.list(project)).sequence;
        yield* todos.acknowledge(project, {
          sequence: receipt,
          token: (yield* todos.list(project)).deliveryToken ?? "",
        });
        yield* list(project, {});
        expect((yield* todos.list(project)).pending).toEqual([]); // No acknowledgment/wake loop.
        yield* Fiber.interrupt(observer);
      }).pipe(Effect.provide(f.app, { local: true }));
      yield* Effect.gen(function* () {
        yield* (yield* ApplicationState).initialize();
        yield* list(project, {});
        expect((yield* todos.read(project, ids.canonical)).state).toBe("done");
        expect((yield* todos.list(project)).selectedId).toBeNull();
        expect((yield* todos.read(project, ids.source)).state).toBe("open");
        expect((yield* todos.list(project)).pending).toEqual([]);
      }).pipe(Effect.provide(f.app, { local: true }));
    }).pipe(Effect.provide(f.metadata));
  },
);

it.effect(
  "restart reconciles restored required sessions without reopening explicit completion",
  () => {
    const f = fixture();
    return Effect.gen(function* () {
      const ids = yield* Effect.gen(function* () {
        yield* upsertProject(project, "Project");
        const automatic = yield* create([a]);
        const explicit = yield* create([b]);
        f.resolved.add(a);
        yield* completeLinked(project);
        yield* todos.mutateUser(project, {
          _tag: "SetState",
          id: explicit.id,
          expectedRevision: 0,
          state: "done",
        });
        return { automatic: automatic.id, explicit: explicit.id };
      }).pipe(Effect.provide(f.app, { local: true }));
      f.resolved.clear(); // Restored while the owning list was not observed.
      yield* Effect.gen(function* () {
        yield* (yield* ApplicationState).initialize();
        yield* list(project, {});
        expect(yield* todos.read(project, ids.automatic)).toMatchObject({
          state: "open",
          revision: 2,
        });
        expect(yield* todos.read(project, ids.explicit)).toMatchObject({
          state: "done",
          revision: 1,
          completion: { by: "user" },
        });
        const writes = f.reads.writes;
        yield* list(project, {});
        expect(f.reads.writes).toBe(writes);
      }).pipe(Effect.provide(f.app, { local: true }));
    }).pipe(Effect.provide(f.metadata));
  },
);

it.effect(
  "requires every actual association resolved; unknown/ambiguous refs and mere report success stay open, source links cannot veto",
  () => {
    const f = fixture();
    return Effect.gen(function* () {
      yield* upsertProject(project, "Project");
      const multiple = yield* create([a, b]);
      const missing = yield* seedHistoricalTodo(project, {
        title: "Legacy missing",
        description: "Historical links.",
        associations: [link(a), link("00000099")],
      });
      const ambiguous = yield* seedHistoricalTodo(project, {
        title: "Legacy ambiguous",
        description: "Historical suffix.",
        associations: [link("00000011")],
      });
      const mixed = yield* seedHistoricalTodo(project, {
        title: "Implementation",
        description: "Deliver implementation.",
        status: "Success; report delivered; stopped",
        associations: [
          link(a),
          {
            kind: "source",
            ref: `cake://session/${b}?message=report`,
            title: "Unresolved report context",
          },
        ],
      });
      yield* completeLinked(project);
      expect((yield* todos.read(project, mixed.id)).state).toBe("open");
      f.resolved.add(a);
      f.identities.push("11111111-1111-4111-8111-000000000011");
      yield* completeLinked(project);
      expect((yield* todos.read(project, multiple.id)).state).toBe("open");
      expect((yield* todos.read(project, mixed.id)).state).toBe("done");
      expect((yield* todos.read(project, missing.id)).state).toBe("open");
      expect((yield* todos.read(project, ambiguous.id)).state).toBe("open");
      f.resolved.add(b);
      yield* completeLinked(project);
      expect((yield* todos.read(project, multiple.id)).state).toBe("done");
      f.resolved.delete(b); // Restoring one required session reopens only its automatic outcome.
      yield* completeLinked(project);
      expect((yield* todos.read(project, mixed.id)).state).toBe("done");
      expect(yield* todos.read(project, multiple.id)).toMatchObject({
        state: "open",
        revision: 2,
        needsAttention: false,
      });
      expect((yield* todos.read(project, multiple.id)).completion).toBeUndefined();
      const writes = f.reads.writes;
      yield* completeLinked(project);
      expect(f.reads.writes).toBe(writes);
      f.resolved.add(b);
      yield* completeLinked(project);
      expect(yield* todos.read(project, multiple.id)).toMatchObject({
        state: "done",
        revision: 3,
        completion: { by: "sessions" },
      });
    }).pipe(Effect.provide(Layer.merge(f.app, f.metadata)));
  },
);

it.effect("revision checks preserve newer associations and explicit closure during a join", () => {
  const f = fixture();
  return Effect.gen(function* () {
    yield* upsertProject(project, "Project");
    const item = yield* create([a]);
    yield* todos.update(project, {
      id: item.id,
      expectedRevision: 0,
      associations: [link(a), link(b)],
    });
    yield* todos.completeResolved(project, [item]);
    expect((yield* todos.read(project, item.id)).state).toBe("open");
    yield* todos.mutateUser(project, {
      _tag: "SetState",
      id: item.id,
      expectedRevision: 1,
      state: "done",
    });
    yield* todos.completeResolved(project, [item]);
    expect((yield* todos.read(project, item.id)).revision).toBe(2);
  }).pipe(Effect.provide(f.app));
});
