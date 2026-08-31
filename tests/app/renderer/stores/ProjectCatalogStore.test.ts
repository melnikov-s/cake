import { Effect, Layer, Queue, Ref } from "effect";
import { mount } from "effect-state-tree";
import { it } from "@effect/vitest";
import { describe, expect } from "vitest";
import { CakeIpcClient } from "../../../../src/ipc/client/CakeIpcClient";
import { ProjectCatalogStoreFactory } from "../../../../src/renderer/stores/ProjectCatalogStore";
import { SessionCatalogStoreFactory } from "../../../../src/renderer/stores/SessionCatalogStore";
import { makeCatalogTestClient, type CatalogTestClient } from "./catalog-test-client";

const project = (path: string, name: string, lastOpenedAt = "2026-08-01T00:00:00.000Z") => ({
  path,
  name,
  addedAt: "2026-08-01T00:00:00.000Z",
  lastOpenedAt,
});

const mountStores = Effect.fn("Test.mountProjectCatalog")(function* (
  controlled: CatalogTestClient,
) {
  const layer = Layer.succeed(CakeIpcClient)(controlled.client);
  const sessions = yield* mount(SessionCatalogStoreFactory, {
    managedWorktrees: [],
    loading: true,
    revision: 0,
    sourceRevision: -1,
  }).pipe(Effect.provide(layer));
  yield* Queue.offer(controlled.sessionUpdates, {
    _tag: "Snapshot",
    revision: 1,
    sessions: [],
  });
  yield* sessions.instance.awaitHydrated();
  const projects = yield* mount(ProjectCatalogStoreFactory, {
    props: { sessions: sessions.instance },
    recentPaths: [],
    loading: true,
    revision: 0,
    sourceRevision: -1,
  }).pipe(Effect.provide(layer));
  return { projects, sessions };
});

describe("ProjectCatalogStore", () => {
  it.effect("hydrates a Snapshot, keeps Model identity, and replaces on reconnect", () =>
    Effect.gen(function* () {
      const controlled = yield* makeCatalogTestClient();
      const handles = yield* mountStores(controlled);
      yield* Queue.offer(controlled.projectUpdates, {
        _tag: "Snapshot",
        revision: 7,
        projects: [project("/first", "First"), project("/second", "Second")],
      });
      yield* handles.projects.instance.awaitHydrated();
      const first = handles.projects.instance.find("/first");
      handles.projects.instance.restoreRecentPaths(["/second", "/first"]);
      expect(handles.projects.instance.recentProjectPaths).toEqual(["/second", "/first"]);

      yield* Queue.offer(controlled.projectUpdates, {
        _tag: "Event",
        revision: 8,
        event: {
          _tag: "Upserted",
          project: project("/first", "Renamed", "2026-08-02T00:00:00.000Z"),
        },
      });
      yield* Effect.yieldNow;
      expect(handles.projects.instance.find("/first")).toBe(first);
      expect(first?.name).toBe("Renamed");

      yield* Queue.offer(controlled.projectUpdates, {
        _tag: "Snapshot",
        revision: 1,
        projects: [project("/third", "Third")],
      });
      yield* Effect.yieldNow;
      expect(handles.projects.instance.projects.map((value) => value.path)).toEqual(["/third"]);
      expect(handles.projects.instance.sourceRevision.value).toBe(1);
      yield* handles.projects.dispose;
      yield* handles.sessions.dispose;
    }),
  );

  it.effect("orders Project selection by latest flat Session activity", () =>
    Effect.gen(function* () {
      const controlled = yield* makeCatalogTestClient();
      const handles = yield* mountStores(controlled);
      yield* Queue.offer(controlled.projectUpdates, {
        _tag: "Snapshot",
        revision: 1,
        projects: [project("/first", "First"), project("/second", "Second")],
      });
      yield* handles.projects.instance.awaitHydrated();
      handles.projects.instance.restoreRecentPaths(["/first", "/second"]);
      yield* handles.sessions.instance.replace([
        {
          id: "newer",
          title: "Newer",
          created: "2026-08-04T00:00:00.000Z",
          modified: "2026-08-04T00:00:00.000Z",
          messageCount: 1,
          resolved: false,
          unread: false,
          workspacePath: "/second",
          workspaceName: "Second",
        },
      ]);
      expect(handles.projects.instance.orderedProjectPaths).toEqual(["/second", "/first"]);
      yield* handles.projects.dispose;
      yield* handles.sessions.dispose;
    }),
  );

  it.effect("filters stale targets and rejects Project identity collisions", () =>
    Effect.gen(function* () {
      const controlled = yield* makeCatalogTestClient();
      const handles = yield* mountStores(controlled);
      yield* Queue.offer(controlled.projectUpdates, {
        _tag: "Snapshot",
        revision: 3,
        projects: [project("/kept", "Kept")],
      });
      yield* handles.projects.instance.awaitHydrated();
      yield* Queue.offer(controlled.projectUpdates, {
        _tag: "Event",
        revision: 4,
        event: { _tag: "Removed", path: "/gone" },
      });
      yield* Effect.yieldNow;
      expect(handles.projects.instance.find("/kept")).toBeDefined();
      expect(handles.projects.instance.sourceRevision.value).toBe(4);
      const error = yield* Effect.flip(
        handles.projects.instance.replace([project("/same", "One"), project("/same", "Two")]),
      );
      expect(error._tag).toBe("IdentityCollisionError");
      expect(handles.projects.instance.find("/kept")).toBeDefined();
      yield* handles.projects.dispose;
      yield* handles.sessions.dispose;
    }),
  );

  it.effect("interrupts the Project subscription on Scope cleanup", () =>
    Effect.gen(function* () {
      const finalized = yield* Ref.make(false);
      const controlled = yield* makeCatalogTestClient({
        projectFinalizer: Ref.set(finalized, true),
      });
      const handles = yield* mountStores(controlled);
      yield* Queue.offer(controlled.projectUpdates, {
        _tag: "Snapshot",
        revision: 1,
        projects: [],
      });
      yield* handles.projects.instance.awaitHydrated();
      yield* handles.projects.dispose;
      yield* Effect.yieldNow;
      expect(yield* Ref.get(finalized)).toBe(true);
      yield* handles.sessions.dispose;
    }),
  );
});
