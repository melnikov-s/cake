/** @vitest-environment jsdom */
import { act, render } from "@testing-library/react";
import { applySnapshot } from "r-state-tree";
import { StoreProvider } from "r-state-tree/react";
import { expect, it, vi } from "vitest";
import type { Client } from "../../../src/renderer/client/Client";
import { WorktreePill } from "../../../src/renderer/components/worktree-pill";
import { applyWorktreeOperationCatalogUpdate } from "../../../src/renderer/reducers/WorktreeOperationReducer";
import { projectRecord, sessionSummary } from "./fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "./renderer-store-fixture";

type LandingSnapshot = Awaited<ReturnType<Client["managedWorktrees"]["landing"]>>;

it.each(["success", "failure"] as const)(
  "drops queued status demand when a %s response arrives after window disposal",
  async (outcome) => {
    let resolve!: (snapshot: LandingSnapshot) => void;
    let reject!: (error: Error) => void;
    const response = new Promise<LandingSnapshot>((complete, fail) => {
      resolve = complete;
      reject = fail;
    });
    // Deliberately ignore cancellation at the service boundary: an already-settling
    // response must still be harmless after the window and its child Stores die.
    const landing = vi.fn<Client["managedWorktrees"]["landing"]>(() => response);
    const cancelLanding = vi.fn<Client["managedWorktrees"]["cancelLanding"]>(async () => {});
    using fixture = createRendererStoreFixture({
      projects: [projectRecord({ path: "/project" })],
      sessions: [
        sessionSummary({
          sessionId: "session-1",
          projectPath: "/project",
          workingDirectory: "/worktree",
        }),
      ],
      client: { managedWorktrees: { landing, cancelLanding } },
    });
    const record = {
      projectPath: "/project",
      worktreePath: "/worktree",
      branch: "agent/feature",
      baseBranch: "main",
      createdAt: "2026-01-01T00:00:00.000Z",
      state: "active" as const,
    };
    applySnapshot(fixture.models.worktrees, { worktrees: [record] });
    fixture.root.navigationStore.selectProjectSession("session-1");
    const session = fixture.root.sessionRegistry.load("session-1", "/worktree");
    const actions = session.worktreeStore;
    const view = render(
      <StoreProvider store={fixture.root}>
        <WorktreePill
          creation={fixture.root.projectSessionCreationStore.worktrees}
          actions={actions}
          record={record}
          sessionId="session-1"
          projectPath="/project"
          onConfigured={() => {}}
        />
      </StoreProvider>,
    );
    try {
      expect(landing).toHaveBeenCalledOnce();
      expect(actions.signal.aborted).toBe(false);
      // A real authority projection while the status request is pending queues
      // another refresh; normal live-window draining is covered by worktree-workflow.
      await act(async () => {
        applyWorktreeOperationCatalogUpdate(fixture.models.worktreeOperations, {
          operations: [
            {
              operationId: "landing-operation",
              workspacePath: "/worktree",
              sessionId: "session-1",
              kind: "landing",
              phase: "stalled",
              strategy: "preserve",
              allowDirtyTarget: false,
              pauseReason: "commit",
            },
          ],
        });
      });
      expect(landing).toHaveBeenCalledOnce();
      view.unmount();
      fixture[Symbol.dispose]();
      expect(actions.signal.aborted).toBe(true);
      await act(async () => {
        if (outcome === "success") resolve({});
        else reject(new Error("Late status transport failure"));
      });
      // A queued callback can also retain the public refresh entry point. It must
      // not read enabled/selection through the now-disposed Root Store.
      await expect(actions.refresh()).resolves.toBeUndefined();
      expect(landing).toHaveBeenCalledOnce();
      expect(cancelLanding).not.toHaveBeenCalled();
      expect(landing).toHaveBeenCalledWith(
        { workspacePath: "/worktree", sessionId: "session-1" },
        { signal: actions.signal },
      );
    } finally {
      view.unmount();
    }
  },
);
