import { Effect, Layer, Queue, Ref } from "effect";
import { mount } from "effect-state-tree";
import { it } from "@effect/vitest";
import { describe, expect } from "vitest";
import type { ProjectSessionSummary } from "../../../../src/domain/project-session-data";
import { CakeIpcClient } from "../../../../src/ipc/client/CakeIpcClient";
import { SessionCatalogStoreFactory } from "../../../../src/renderer/stores/SessionCatalogStore";
import { makeCatalogTestClient, type CatalogTestClient } from "./catalog-test-client";

const summary = (
  sessionId: string,
  modifiedAt: string,
  projectPath = "/project",
): ProjectSessionSummary => ({
  sessionId,
  title: sessionId,
  createdAt: modifiedAt,
  modifiedAt,
  messageCount: 1,
  resolved: false,
  unread: false,
  projectPath,
  projectName: projectPath.slice(1),
  workingDirectory: projectPath,
});

const mountStore = Effect.fn("Test.mountSessionCatalog")(function* (controlled: CatalogTestClient) {
  return yield* mount(SessionCatalogStoreFactory, {
    managedWorktrees: [],
    loading: true,
    revision: 0,
    sourceRevision: -1,
  }).pipe(Effect.provide(Layer.succeed(CakeIpcClient)(controlled.client)));
});

describe("SessionCatalogStore", () => {
  it.effect("hydrates the initial Snapshot in flat activity order and preserves identity", () =>
    Effect.gen(function* () {
      const controlled = yield* makeCatalogTestClient();
      const handle = yield* mountStore(controlled);
      yield* Queue.offer(controlled.sessionUpdates, {
        _tag: "Snapshot",
        revision: 4,
        sessions: [
          summary("older", "2026-08-15T00:00:00.000Z"),
          summary("latest", "2026-08-16T00:00:00.000Z"),
        ],
      });
      yield* handle.instance.awaitHydrated();
      expect(handle.instance.sessions.map((session) => session.id)).toEqual(["latest", "older"]);
      const latest = handle.instance.find("latest");

      yield* Queue.offer(controlled.sessionUpdates, {
        _tag: "Event",
        revision: 5,
        event: {
          _tag: "Replaced",
          sessions: [summary("latest", "2026-08-17T00:00:00.000Z")],
        },
      });
      yield* Effect.yieldNow;
      expect(handle.instance.find("latest")).toBe(latest);
      expect(latest?.modified).toBe("2026-08-17T00:00:00.000Z");
      yield* handle.dispose;
    }),
  );

  it.effect("filters out-of-order Events", () =>
    Effect.gen(function* () {
      const controlled = yield* makeCatalogTestClient();
      const handle = yield* mountStore(controlled);
      yield* Queue.offer(controlled.sessionUpdates, {
        _tag: "Snapshot",
        revision: 10,
        sessions: [summary("current", "2026-08-16T00:00:00.000Z")],
      });
      yield* handle.instance.awaitHydrated();
      yield* Queue.offer(controlled.sessionUpdates, {
        _tag: "Event",
        revision: 9,
        event: { _tag: "Removed", sessionId: "current" },
      });
      yield* Effect.yieldNow;
      expect(handle.instance.find("current")).toBeDefined();
      expect(handle.instance.sourceRevision.value).toBe(10);
      yield* handle.dispose;
    }),
  );

  it.effect("accepts a reconnect Snapshot as a complete replacement", () =>
    Effect.gen(function* () {
      const controlled = yield* makeCatalogTestClient();
      const handle = yield* mountStore(controlled);
      yield* Queue.offer(controlled.sessionUpdates, {
        _tag: "Snapshot",
        revision: 8,
        sessions: [summary("before", "2026-08-16T00:00:00.000Z")],
      });
      yield* handle.instance.awaitHydrated();
      yield* handle.instance.upsertPending("pending", "/project", "Project");
      yield* Queue.offer(controlled.sessionUpdates, {
        _tag: "Snapshot",
        revision: 1,
        sessions: [summary("after", "2026-08-17T00:00:00.000Z")],
      });
      yield* Effect.yieldNow;
      expect(handle.instance.sessions.map((session) => session.id)).toEqual(["pending", "after"]);
      expect(handle.instance.sourceRevision.value).toBe(1);
      yield* handle.dispose;
    }),
  );

  it.effect("ignores a stale target while advancing observation order", () =>
    Effect.gen(function* () {
      const controlled = yield* makeCatalogTestClient();
      const handle = yield* mountStore(controlled);
      yield* Queue.offer(controlled.sessionUpdates, {
        _tag: "Snapshot",
        revision: 2,
        sessions: [summary("kept", "2026-08-16T00:00:00.000Z")],
      });
      yield* handle.instance.awaitHydrated();
      yield* Queue.offer(controlled.sessionUpdates, {
        _tag: "Event",
        revision: 3,
        event: { _tag: "StatusChanged", sessionId: "gone", resolved: true, unread: false },
      });
      yield* Effect.yieldNow;
      expect(handle.instance.sessions.map((session) => session.id)).toEqual(["kept"]);
      expect(handle.instance.sourceRevision.value).toBe(3);
      yield* handle.dispose;
    }),
  );

  it.effect("rejects identity collisions without replacing the current projection", () =>
    Effect.gen(function* () {
      const controlled = yield* makeCatalogTestClient();
      const handle = yield* mountStore(controlled);
      yield* Queue.offer(controlled.sessionUpdates, {
        _tag: "Snapshot",
        revision: 1,
        sessions: [summary("kept", "2026-08-16T00:00:00.000Z")],
      });
      yield* handle.instance.awaitHydrated();
      const duplicate = {
        id: "duplicate",
        title: "duplicate",
        created: "2026-08-17T00:00:00.000Z",
        modified: "2026-08-17T00:00:00.000Z",
        messageCount: 1,
        resolved: false,
        unread: false,
        workspacePath: "/project",
        workspaceName: "Project",
      };
      const error = yield* Effect.flip(handle.instance.replace([duplicate, duplicate]));
      expect(error._tag).toBe("IdentityCollisionError");
      expect(handle.instance.sessions.map((session) => session.id)).toEqual(["kept"]);
      yield* handle.dispose;
    }),
  );

  it.effect("groups Projects and derives resolved landed worktrees", () =>
    Effect.gen(function* () {
      const controlled = yield* makeCatalogTestClient();
      const handle = yield* mountStore(controlled);
      const worktree = {
        projectPath: "/project",
        worktreePath: "/worktree",
        branch: "agent/task",
        baseBranch: "main",
        state: "landed" as const,
        createdAt: "2026-08-16T00:00:00.000Z",
      };
      yield* Queue.offer(controlled.sessionUpdates, {
        _tag: "Snapshot",
        revision: 1,
        sessions: [
          {
            ...summary("resolved", "2026-08-16T00:00:00.000Z"),
            resolved: true,
            workingDirectory: worktree.worktreePath,
            managedWorktree: worktree,
          },
          summary("other", "2026-08-15T00:00:00.000Z", "/other"),
        ],
      });
      yield* handle.instance.awaitHydrated();
      expect(handle.instance.projectSessions("/project").map((session) => session.id)).toEqual([
        "resolved",
      ]);
      expect(handle.instance.resolvedWorktrees("/project")).toEqual([worktree]);
      yield* handle.dispose;
    }),
  );

  it.effect("interrupts its catalog subscription when its Scope closes", () =>
    Effect.gen(function* () {
      const finalized = yield* Ref.make(false);
      const controlled = yield* makeCatalogTestClient({
        sessionFinalizer: Ref.set(finalized, true),
      });
      const handle = yield* mountStore(controlled);
      yield* Queue.offer(controlled.sessionUpdates, {
        _tag: "Snapshot",
        revision: 1,
        sessions: [],
      });
      yield* handle.instance.awaitHydrated();
      yield* handle.dispose;
      yield* Effect.yieldNow;
      expect(yield* Ref.get(finalized)).toBe(true);
    }),
  );
});
