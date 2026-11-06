import { it } from "@effect/vitest";
import { expect } from "vitest";
import { Effect, Layer, Stream } from "effect";
import type { WorktreeRecord } from "../../../src/contracts/worktrees/managed-worktree-data";
import { observe } from "../../../src/domain/worktrees/worktreeCatalog";
import { Git } from "../../../src/services/git/Git";
import { ManagedWorktrees } from "../../../src/services/worktrees/ManagedWorktrees";

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
          Layer.merge(
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
                run: (cwd) => {
                  calls.push(cwd);
                  return Effect.succeed("origin/trunk\n");
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
            { ...record, defaultBranch: "trunk" },
            { ...sibling, defaultBranch: "trunk" },
          ],
        },
        {
          _tag: "Event",
          event: { _tag: "Upserted", worktree: { ...landed, defaultBranch: "trunk" } },
        },
      ]);
      expect(calls).toEqual(["/project", "/project"]);
      expect(record).not.toHaveProperty("defaultBranch");
    }),
);
