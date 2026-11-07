/** @vitest-environment jsdom */
import { cleanup, render, within } from "@testing-library/react";
import { StoreProvider } from "r-state-tree/react";
import { afterEach, expect, it } from "vitest";
import { Effect, Layer, Schema, Stream } from "effect";
import { CaptureSessionOption } from "../../../src/contracts/desktop/screen-capture-data";
import { ManagedWorktreeCatalogUpdate } from "../../../src/contracts/worktrees/managed-worktree-data";
import { observe } from "../../../src/domain/worktrees/worktreeCatalog";
import { Git, GitError } from "../../../src/services/git/Git";
import { ManagedWorktrees } from "../../../src/services/worktrees/ManagedWorktrees";
import { SessionCatalogChanges } from "../../../src/services/session-catalogs/SessionCatalogChanges";
import { ConversationNavigator } from "../../../src/renderer/components/conversation-navigator";
import { applyManagedWorktreeCatalogUpdate } from "../../../src/renderer/reducers/WorktreeCatalogReducer";
import { projectRecord, sessionSummary } from "./fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "./renderer-store-fixture";

afterEach(cleanup);

it.each([
  { detected: "main", base: "main", label: undefined },
  { detected: "master", base: "master", label: undefined },
  { detected: "trunk", base: "trunk", label: undefined },
  { detected: "release/stable", base: "release/stable", label: undefined },
  { detected: undefined, base: "main", label: undefined },
  { detected: undefined, base: "master", label: undefined },
  { detected: undefined, base: "feature/search", label: "feature/search" },
  { detected: "main", base: "feature/search", label: "feature/search" },
  { detected: "main", base: "master", label: "master" },
  { detected: "master", base: "main", label: "main" },
  { detected: "trunk", base: "main", label: "main" },
  { detected: "trunk", base: "agent/release", label: "release" },
  { detected: undefined, base: "agent/main", label: "main" },
])(
  "shows base $base with locally detected default $detected",
  async ({ detected, base, label }) => {
    const record = {
      projectPath: "/project",
      worktreePath: "/worktree",
      branch: "agent/change",
      baseBranch: base,
      state: "active" as const,
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const calls: Array<{ cwd: string; args: ReadonlyArray<string> }> = [];
    const updates = await Effect.runPromise(
      observe().pipe(
        Stream.runCollect,
        Effect.provide(
          Layer.mergeAll(
            Layer.mock(SessionCatalogChanges, { initialThenChanges: (initial) => initial }),
            Layer.mock(ManagedWorktrees, {
              observe: () => Stream.make({ _tag: "Snapshot", worktrees: [record] }),
            }),
            Layer.succeed(
              Git,
              Git.of({
                run: (cwd, args) => {
                  calls.push({ cwd, args });
                  return detected
                    ? Effect.succeed(`origin/${detected}\n`)
                    : Effect.fail(
                        new GitError({
                          operation: "symbolic-ref",
                          workingDirectory: cwd,
                          message: "No local remote HEAD",
                        }),
                      );
                },
              }),
            ),
          ),
        ),
      ),
    );
    using fixture = createRendererStoreFixture({
      projects: [projectRecord({ path: record.projectPath, name: "Project" })],
      sessions: [
        sessionSummary({
          sessionId: "session",
          title: "Worktree session",
          projectPath: record.projectPath,
          workingDirectory: record.worktreePath,
        }),
      ],
    });
    for (const update of updates)
      applyManagedWorktreeCatalogUpdate(
        fixture.models.worktrees,
        Schema.decodeUnknownSync(ManagedWorktreeCatalogUpdate)(update),
      );
    const { root } = fixture;
    const view = render(
      <StoreProvider store={root}>
        <ConversationNavigator projectPath={record.projectPath} />
      </StoreProvider>,
    );
    try {
      const row = within(view.container.querySelector<HTMLElement>('[data-session-id="session"]')!);
      expect(row.getByText("change")).toBeDefined();
      expect(row.queryByText("→") !== null).toBe(label !== undefined);
      if (label !== undefined) expect(row.getByText(label, { exact: true })).toBeDefined();
      else expect(row.queryByText(base, { exact: true })).toBeNull();
      expect(root.sessionCatalogStore.managedWorktree(record.worktreePath)?.baseBranch).toBe(base);
      expect(record).not.toHaveProperty("defaultBranch");
      expect(calls).toEqual([
        {
          cwd: record.projectPath,
          args: ["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"],
        },
      ]);

      // Native capture destinations freeze the same shared row facts across their schema boundary.
      const option = root.screenCaptureStore.destinations.projects[0]?.sessions[0];
      const decoded = Schema.decodeUnknownSync(CaptureSessionOption)(option);
      expect(decoded.managedWorktree?.defaultBranch).toBe(detected);
      expect(decoded.managedWorktree?.baseBranch).toBe(base);
    } finally {
      view.unmount();
    }
  },
);
