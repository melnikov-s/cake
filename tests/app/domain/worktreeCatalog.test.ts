import { it } from "@effect/vitest";
import { expect } from "vitest";
import { Effect, Layer, Queue, Stream } from "effect";
import type { ManagedWorktreeCatalogUpdate } from "../../../src/contracts/worktrees/managed-worktree-data";
import type { WorktreeRecord } from "../../../src/contracts/worktrees/managed-worktree-data";
import { observe } from "../../../src/domain/worktrees/worktreeCatalog";
import { Git, GitError } from "../../../src/services/git/Git";
import { ManagedWorktrees } from "../../../src/services/worktrees/ManagedWorktrees";
import { SessionCatalogChanges } from "../../../src/services/session-catalogs/SessionCatalogChanges";

it.effect(
  "reads the local default once per Project per update and preserves ordered lifecycle facts",
  () =>
    Effect.gen(function* () {
      const record: WorktreeRecord = {
        projectPath: "/project",
        worktreePath: "/worktree",
        branch: "agent/change",
        baseBranch: "feature/base",
        createdAt: "2026-01-01T00:00:00.000Z",
      };
      const sibling = { ...record, worktreePath: "/sibling", branch: "agent/sibling" };
      const landed = { ...record, state: "landed" as const };
      const calls: string[] = [];
      const updates = yield* observe().pipe(
        Stream.runCollect,
        Effect.provide(
          Layer.mergeAll(
            Layer.mock(SessionCatalogChanges, { initialThenChanges: (initial) => initial }),
            Layer.mock(ManagedWorktrees, {
              observe: () =>
                Stream.make(
                  { _tag: "Snapshot", worktrees: [record, sibling] },
                  { _tag: "Event", event: { _tag: "Upserted", worktree: landed } },
                ),
            }),
            Layer.succeed(
              Git,
              Git.of({
                run: (cwd, args) => {
                  if (args[0] === "symbolic-ref") {
                    calls.push(cwd);
                    return Effect.succeed("origin/trunk\n");
                  }
                  return Effect.fail(
                    new GitError({ operation: "read", workingDirectory: cwd, message: "No refs" }),
                  );
                },
              }),
            ),
          ),
        ),
      );
      expect(updates).toEqual([
        {
          _tag: "Snapshot",
          worktrees: [
            {
              ...record,
              defaultBranch: "trunk",
              contributionStats: { additions: null, deletions: null, unavailableReason: "No refs" },
            },
            {
              ...sibling,
              defaultBranch: "trunk",
              contributionStats: { additions: null, deletions: null, unavailableReason: "No refs" },
            },
          ],
        },
        {
          _tag: "Event",
          event: {
            _tag: "Upserted",
            worktree: {
              ...landed,
              defaultBranch: "trunk",
              contributionStats: { additions: null, deletions: null, unavailableReason: "No refs" },
            },
          },
        },
      ]);
      expect(calls).toEqual(["/project", "/project"]);
      expect(record).not.toHaveProperty("defaultBranch");
      expect(record).not.toHaveProperty("contributionStats");
    }),
);

it.effect(
  "refreshes stats through existing activity and lifecycle updates, reuses unchanged tips and clears unavailable stats",
  () =>
    Effect.gen(function* () {
      const record: WorktreeRecord = {
        projectPath: "/project",
        worktreePath: "/worktree",
        branch: "agent/change",
        baseBranch: "main",
        baseCommit: "base",
        contributionRef: "refs/cake/contributions/test",
        createdAt: "",
      };
      let tip: string | undefined = "first";
      let diffCalls = 0;
      let targetLanded = false;
      const lifecycle = yield* Queue.unbounded<ManagedWorktreeCatalogUpdate>();
      const updates = yield* Queue.unbounded<ManagedWorktreeCatalogUpdate>();
      const changes = yield* SessionCatalogChanges;
      yield* observe().pipe(
        Stream.runForEach((update) => Queue.offer(updates, update)),
        Effect.provide(
          Layer.mergeAll(
            Layer.mock(ManagedWorktrees, {
              records: () => Effect.succeed([record]),
              observe: () =>
                Stream.make({
                  _tag: "Snapshot" as const,
                  worktrees: [record],
                }).pipe(Stream.concat(Stream.fromQueue(lifecycle))),
            }),
            Layer.succeed(
              Git,
              Git.of({
                run: (cwd, args) => {
                  if (args[0] === "symbolic-ref") return Effect.succeed("origin/main\n");
                  if (!tip)
                    return Effect.fail(
                      new GitError({
                        operation: "read",
                        workingDirectory: cwd,
                        message: "Missing branch",
                      }),
                    );
                  if (args[0] === "rev-parse") {
                    const ref = args.at(-1)?.replace(/\^\{commit\}$/, "") ?? "";
                    return Effect.succeed(
                      ref === "refs/heads/agent/change"
                        ? tip
                        : ref === "refs/heads/main"
                          ? targetLanded
                            ? "target"
                            : "base"
                          : ref === "refs/cake/contributions/test"
                            ? targetLanded
                              ? "checkpoint-landed"
                              : "checkpoint"
                            : ref,
                    );
                  }
                  if (args[0] === "show")
                    return Effect.succeed(
                      JSON.stringify({
                        version: 1,
                        origin: "base",
                        source: targetLanded ? tip : "base",
                        baseline: "base",
                      }),
                    );
                  if (args[0] === "merge-base")
                    return Effect.fail(
                      new GitError({
                        operation: "ancestor",
                        workingDirectory: cwd,
                        message: "not ancestor",
                      }),
                    );
                  if (args[0] === "rev-list")
                    return Effect.succeed(
                      args.includes(`^${tip}`)
                        ? ""
                        : tip === "first"
                          ? "first base"
                          : "next first\nfirst base",
                    );
                  if (args[0] === "diff") {
                    diffCalls++;
                    return Effect.succeed("120\t35\tcode.ts\0");
                  }
                  return Effect.die(`Unexpected Git command: ${args.join(" ")}`);
                },
              }),
            ),
          ),
        ),
        Effect.forkScoped,
      );
      const initial = yield* Queue.take(updates);
      expect(initial._tag === "Snapshot" && initial.worktrees[0]?.contributionStats).toEqual({
        additions: 120,
        deletions: 35,
        unavailableReason: null,
      });
      tip = "next";
      const activity = {
        _tag: "ProjectSessionActivityChanged" as const,
        sessionId: "session",
        projectPath: "/project",
        workingDirectory: "/worktree",
        sessionDirectory: "/sessions",
      };
      yield* changes.publish(activity);
      const refreshed = yield* Queue.take(updates);
      expect(refreshed._tag === "Event" && refreshed.event.worktree.contributionStats).toEqual({
        unavailableReason: null,
        additions: 120,
        deletions: 35,
      });
      yield* changes.publish(activity);
      yield* Queue.take(updates);
      expect(diffCalls).toBe(2);
      // Activity in the landing target must refresh the unchanged source branch too.
      targetLanded = true;
      yield* changes.publish({ ...activity, workingDirectory: "/project" });
      const landed = yield* Queue.take(updates);
      expect(landed._tag === "Event" && landed.event.worktree.contributionStats).toEqual({
        unavailableReason: null,
        additions: 120,
        deletions: 35,
      });
      tip = undefined;
      yield* Queue.offer(lifecycle, {
        _tag: "Event",
        event: { _tag: "Upserted", worktree: { ...record, state: "missing" } },
      });
      const missing = yield* Queue.take(updates);
      expect(missing._tag === "Event" && missing.event.worktree.contributionStats).toEqual({
        additions: null,
        deletions: null,
        unavailableReason: "Missing branch",
      });
    }).pipe(Effect.provide(SessionCatalogChanges.layer)),
);
