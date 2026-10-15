/** @vitest-environment jsdom */
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { applySnapshot } from "r-state-tree";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorktreeLandingOperation } from "../../../src/contracts/worktrees/worktree-landing-data";
import type { WorktreeStatus } from "../../../src/contracts/worktrees/worktree-contract";
import type { Client } from "../../../src/renderer/client/Client";
import { ToastHost } from "../../../src/renderer/components/toast-host";
import { WorktreePill } from "../../../src/renderer/components/worktree-pill";
import { applyWorktreeOperationCatalogUpdate } from "../../../src/renderer/reducers/WorktreeOperationReducer";
import { projectRecord, sessionSummary } from "./fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "./renderer-store-fixture";

const familyId = "10000000-0000-4000-8000-000000000001";

const status = (worktreePath: string): WorktreeStatus => ({
  record: {
    projectPath: "/project",
    worktreePath,
    branch: `agent${worktreePath}`,
    baseBranch: "main",
    createdAt: "2026-01-01T00:00:00.000Z",
    state: "active",
  },
  targetBranch: "main",
  aheadCount: 1,
  behindCount: 0,
  dirtyCount: 0,
  merged: false,
  targetDirty: false,
  targetOnBranch: true,
  merging: false,
  rebasing: false,
  squashMessageReady: false,
});

const landed = (
  operationId: string,
  workspacePath: string,
  sessionId: string,
  resolvedSessionIds?: readonly string[],
): WorktreeLandingOperation => ({
  operationId,
  workspacePath,
  sessionId,
  kind: "landing",
  phase: "landed",
  strategy: "preserve",
  allowDirtyTarget: false,
  resolveAfterLanding: true,
  ...(resolvedSessionIds ? { resolvedSessionIds } : null),
});

/**
 * A family whose root, two children and a nested grandchild share one Managed Worktree, plus an
 * unrelated standalone session in its own worktree. Every session is visible in its own pane, so
 * each owns a live Worktree Store observing its Working Directory's landing operation.
 */
function renderSessions(selectedSessionId = "parent") {
  const sessions = [
    sessionSummary({
      sessionId: "parent",
      projectPath: "/project",
      workingDirectory: "/family",
      familyId,
      familyParentSessionId: "parent",
    }),
    ...["child-1", "child-2", "grandchild"].map((sessionId) =>
      sessionSummary({
        sessionId,
        projectPath: "/project",
        workingDirectory: "/family",
        familyId,
        familyParentSessionId: "parent",
      }),
    ),
    sessionSummary({
      sessionId: "standalone",
      projectPath: "/project",
      workingDirectory: "/standalone",
    }),
  ];
  const statuses = new Map([
    ["/family", status("/family")],
    ["/standalone", status("/standalone")],
  ]);
  const operations = new Map<string, WorktreeLandingOperation>();
  const startLanding = vi.fn<Client["managedWorktrees"]["startLanding"]>(async (request) => ({
    operationId: request.operationId,
    workspacePath: request.workspacePath,
    sessionId: request.sessionId,
    kind: "landing",
    phase: "waiting",
    strategy: request.strategy,
    allowDirtyTarget: request.allowDirtyTarget,
    resolveAfterLanding: request.resolveAfterLanding,
  }));
  const cancelLanding = vi.fn<Client["managedWorktrees"]["cancelLanding"]>(async () => undefined);
  const fixture = createRendererStoreFixture({
    projects: [projectRecord({ path: "/project" })],
    sessions,
    client: {
      managedWorktrees: {
        landing: async ({ workspacePath }) => ({ status: statuses.get(workspacePath) }),
        startLanding,
        cancelLanding,
      },
    },
  });
  applySnapshot(fixture.models.worktrees, {
    worktrees: [...statuses.values()].map((item) => item.record),
  });
  const stores = new Map(
    sessions.map((session) => [
      session.sessionId,
      fixture.root.sessionRegistry.load(session.sessionId, session.workingDirectory),
    ]),
  );
  fixture.root.appShellStore.selectProjectSession(selectedSessionId);
  for (const session of sessions) fixture.root.sessionLayoutStore.ensureSession(session.sessionId);
  const view = render(
    <>
      {sessions.map((session) => (
        <section key={session.sessionId} aria-label={session.sessionId}>
          <WorktreePill
            creation={fixture.root.projectSessionCreationStore.worktrees}
            actions={stores.get(session.sessionId)!.worktreeStore}
            sessionId={session.sessionId}
            projectPath="/project"
            onConfigured={() => undefined}
          />
        </section>
      ))}
      <ToastHost store={fixture.root.toastStore} />
    </>,
  );
  return {
    user: userEvent.setup(),
    startLanding,
    cancelLanding,
    pane: (sessionId: string) => within(screen.getByRole("region", { name: sessionId })),
    /** Publishes main's process-lifetime landing projection to every observing Store. */
    async publish(...next: WorktreeLandingOperation[]) {
      for (const operation of next) operations.set(operation.workspacePath, operation);
      await act(async () => {
        applyWorktreeOperationCatalogUpdate(fixture.models.worktreeOperations, {
          operations: [...operations.values()],
        });
      });
    },
    toasts: () => fixture.root.toastStore.toasts,
    [Symbol.dispose]() {
      view.unmount();
      fixture[Symbol.dispose]();
    },
  };
}

afterEach(cleanup);

describe("Worktree landing completion toasts", () => {
  it("shows one consolidated toast when merging and resolving a parent with nested descendants", async () => {
    using fixture = renderSessions();
    await fixture.user.click(
      await fixture.pane("parent").findByRole("button", { name: "Merge & resolve" }),
    );
    const operationId = fixture.startLanding.mock.calls[0]![0].operationId;
    await fixture.publish(
      landed(operationId, "/family", "parent", ["parent", "child-1", "child-2", "grandchild"]),
    );

    expect(
      await screen.findByText(
        "The worktree was merged into the project and 4 sessions were resolved.",
      ),
    ).toBeDefined();
    // Every pane sharing the worktree finished presenting the same operation.
    await waitFor(() =>
      expect(
        fixture.cancelLanding.mock.calls.filter(([request]) => request.intent === "acknowledge"),
      ).toHaveLength(4),
    );
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.getByText("Sessions merged and resolved")).toBeDefined();
    expect(screen.queryByText("Session merged and resolved")).toBeNull();
  });

  it("counts only the sessions main reported, so already-resolved members are not announced again", async () => {
    using fixture = renderSessions();
    // child-2 was already resolved before this landing, so main reports only the remainder.
    await fixture.publish(
      landed("agent-landing", "/family", "parent", ["parent", "child-1", "grandchild"]),
    );
    expect(
      await screen.findByText(
        "The worktree was merged into the project and 3 sessions were resolved.",
      ),
    ).toBeDefined();
    expect(screen.getAllByRole("status")).toHaveLength(1);
  });

  it("keeps standalone merge-and-resolve to its single-session toast", async () => {
    using fixture = renderSessions("standalone");
    await fixture.user.click(
      await fixture.pane("standalone").findByRole("button", { name: "Merge & resolve" }),
    );
    const operationId = fixture.startLanding.mock.calls[0]![0].operationId;
    await fixture.publish(landed(operationId, "/standalone", "standalone", ["standalone"]));
    expect(await screen.findByText("Session merged and resolved")).toBeDefined();
    expect(
      screen.getByText("This session was merged into the project and resolved."),
    ).toBeDefined();
    expect(screen.getAllByRole("status")).toHaveLength(1);
  });

  it("does not coalesce independent landing operations", async () => {
    using fixture = renderSessions();
    await fixture.publish(
      landed("family-landing", "/family", "parent", ["parent", "child-1", "child-2", "grandchild"]),
      landed("standalone-landing", "/standalone", "standalone", ["standalone"]),
    );
    await waitFor(() => expect(screen.getAllByRole("status")).toHaveLength(2));
    expect(fixture.toasts().map((toast) => toast.coalesceKey)).toEqual([
      "worktree-landed:family-landing",
      "worktree-landed:standalone-landing",
    ]);
    expect(screen.getByText("Sessions merged and resolved")).toBeDefined();
    expect(screen.getByText("Session merged and resolved")).toBeDefined();
  });
});
