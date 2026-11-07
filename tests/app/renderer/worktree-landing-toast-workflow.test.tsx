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
 * unrelated standalone session in its own worktree. Each session's Worktree control is mounted to
 * exercise the shared backend operation independently of conversation selection.
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
  fixture.root.navigationStore.selectProjectSession(selectedSessionId);
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
  it("does not toast a clicked merge-and-resolve for a parent or its nested descendants", async () => {
    using fixture = renderSessions();
    await fixture.user.click(
      await fixture.pane("parent").findByRole("button", { name: "Merge & resolve" }),
    );
    const operationId = fixture.startLanding.mock.calls[0]![0].operationId;
    await fixture.publish({ ...landed(operationId, "/family", "parent"), phase: "queued" });
    expect(
      await fixture.pane("parent").findByRole("button", { name: "Waiting to merge…" }),
    ).toBeDefined();
    await fixture.publish(
      landed(operationId, "/family", "parent", ["parent", "child-1", "child-2", "grandchild"]),
    );

    // Wait for every observer to finish, rather than checking absence before completion.
    await waitFor(() =>
      expect(
        fixture.cancelLanding.mock.calls.filter(([request]) => request.intent === "acknowledge"),
      ).toHaveLength(4),
    );
    expect(fixture.toasts()).toHaveLength(0);
    expect(screen.queryByRole("status")).toBeNull();
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

  it("does not toast a clicked standalone merge-and-resolve, but still toasts a later background landing", async () => {
    using fixture = renderSessions("standalone");
    await fixture.user.click(
      await fixture.pane("standalone").findByRole("button", { name: "Merge & resolve" }),
    );
    const operationId = fixture.startLanding.mock.calls[0]![0].operationId;
    await fixture.publish(landed(operationId, "/standalone", "standalone", ["standalone"]));
    await waitFor(() =>
      expect(fixture.cancelLanding).toHaveBeenCalledWith({
        operationId,
        workspacePath: "/standalone",
        intent: "acknowledge",
      }),
    );
    expect(fixture.toasts()).toHaveLength(0);

    await fixture.publish(
      landed("background-landing", "/standalone", "standalone", ["standalone"]),
    );
    expect(await screen.findByText("Session merged and resolved")).toBeDefined();
    expect(screen.getAllByRole("status")).toHaveLength(1);
  });

  it("stays quiet when completion is projected before the start response arrives", async () => {
    using fixture = renderSessions("standalone");
    let accept!: (operation: WorktreeLandingOperation) => void;
    fixture.startLanding.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          accept = resolve;
        }),
    );
    await fixture.user.click(
      await fixture.pane("standalone").findByRole("button", { name: "Merge & resolve" }),
    );
    const operationId = fixture.startLanding.mock.calls[0]![0].operationId;
    const completion = landed(operationId, "/standalone", "standalone", ["standalone"]);
    await fixture.publish(completion);
    await waitFor(() =>
      expect(fixture.cancelLanding).toHaveBeenCalledWith({
        operationId,
        workspacePath: "/standalone",
        intent: "acknowledge",
      }),
    );
    await act(async () => accept({ ...completion, phase: "waiting" }));
    expect(fixture.toasts()).toHaveLength(0);
  });

  it("still toasts an ordinary clicked Merge", async () => {
    using fixture = renderSessions("standalone");
    await fixture.user.click(
      await fixture.pane("standalone").findByRole("button", { name: /^Merge$/ }),
    );
    const operationId = fixture.startLanding.mock.calls[0]![0].operationId;
    await fixture.publish({
      ...landed(operationId, "/standalone", "standalone"),
      resolveAfterLanding: false,
    });
    expect(await screen.findByText("Worktree merged")).toBeDefined();
    expect(screen.getAllByRole("status")).toHaveLength(1);
  });

  it("keeps direct merge-and-resolve start errors visible", async () => {
    using fixture = renderSessions("standalone");
    fixture.startLanding.mockRejectedValueOnce(new Error("Merge target is unavailable"));
    await fixture.user.click(
      await fixture.pane("standalone").findByRole("button", { name: "Merge & resolve" }),
    );
    expect(await screen.findByText("Merge target is unavailable")).toBeDefined();
    expect(fixture.toasts()).toHaveLength(0);
  });

  it("keeps projected merge-and-resolve failures visible", async () => {
    using fixture = renderSessions("standalone");
    await fixture.user.click(
      await fixture.pane("standalone").findByRole("button", { name: "Merge & resolve" }),
    );
    const operationId = fixture.startLanding.mock.calls[0]![0].operationId;
    await fixture.publish({
      ...landed(operationId, "/standalone", "standalone"),
      phase: "failed",
      error: "Merge could not be completed",
    });
    expect(await screen.findByText("Merge could not be completed")).toBeDefined();
    expect(fixture.toasts()).toHaveLength(0);
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
