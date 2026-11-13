/** @vitest-environment jsdom */
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { applySnapshot } from "r-state-tree";
import { defaultProjectSettings } from "../../../src/contracts/application/application-data";
import { observer, StoreProvider } from "r-state-tree/react";
import { AutoMergeToggle } from "../../../src/renderer/components/auto-merge-toggle";
import type { WorktreeRecord } from "../../../src/contracts/worktrees/managed-worktree-data";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ResolutionCleanupFailed } from "../../../src/contracts/project-sessions/project-session-resolution";
import { applyWorktreeOperationCatalogUpdate } from "../../../src/renderer/reducers/WorktreeOperationReducer";
import type { WorktreeLandingOperation } from "../../../src/contracts/worktrees/worktree-landing-data";
import type { WorktreeStatus } from "../../../src/contracts/worktrees/worktree-contract";
import type { Client } from "../../../src/renderer/client/Client";
import { QuakeTerminal } from "../../../src/renderer/components/quake-terminal";
import { ToastHost } from "../../../src/renderer/components/toast-host";
import { WorktreePill } from "../../../src/renderer/components/worktree-pill";
import { applyConversationUpdate } from "../../../src/renderer/reducers/ConversationReducer";
import { projectRecord, sessionSummary } from "./fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "./renderer-store-fixture";
import type { TestClientOverrides } from "./test-client";

const status = (changes: Partial<WorktreeStatus> = {}): WorktreeStatus => ({
  record: {
    projectPath: "/project",
    worktreePath: "/worktree",
    branch: "agent/feature",
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
  ...changes,
});
const operation = (
  phase: WorktreeLandingOperation["phase"],
  changes: Partial<WorktreeLandingOperation> = {},
): WorktreeLandingOperation => ({
  operationId: "landing-operation",
  workspacePath: "/worktree",
  sessionId: "session-1",
  kind: "landing",
  phase,
  strategy: "preserve",
  allowDirtyTarget: false,
  ...changes,
});
function gate<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
function renderWorktree(
  options: {
    status?: WorktreeStatus;
    operation?: WorktreeLandingOperation;
    streaming?: boolean;
    resolved?: boolean;
    child?: boolean;
    record?: WorktreeRecord;
    client?: TestClientOverrides;
    landing?: "merge" | "pull-request";
  } = {},
) {
  let currentStatus: WorktreeStatus | undefined = options.status ?? status();
  const landing = vi.fn<Client["managedWorktrees"]["landing"]>(async () => ({
    status: currentStatus,
  }));
  const fixture = createRendererStoreFixture({
    projects: [
      projectRecord({
        path: "/project",
        settings: { ...defaultProjectSettings(), worktreeLanding: options.landing ?? "merge" },
      }),
    ],
    sessions: [
      sessionSummary({
        sessionId: "session-1",
        projectPath: "/project",
        workingDirectory: "/worktree",
        resolved: options.resolved,
        familyId: options.child ? "parent" : undefined,
        familyParentSessionId: options.child ? "parent" : undefined,
        familyDepth: options.child ? 1 : undefined,
      }),
      ...(options.child
        ? [
            sessionSummary({
              sessionId: "parent",
              projectPath: "/project",
              familyId: "parent",
              familyParentSessionId: "parent",
              familyChildSessionIds: ["session-1"],
              familyDepth: 0,
            }),
          ]
        : []),
    ],
    client: {
      ...options.client,
      cakeChats: { open: async () => undefined, ...options.client?.cakeChats },
      managedWorktrees: { landing, ...options.client?.managedWorktrees },
      terminals: {
        workingDirectoryStatus: async () => ({ runningProgramCount: 0 }),
        closeWorkingDirectory: async () => undefined,
        ...options.client?.terminals,
      },
    },
  });
  applySnapshot(fixture.models.cakeChatCatalog, {
    loaded: true,
    sessions: [
      {
        sessionId: `project-chat:${"c".repeat(64)}`,
        title: "Project Chat",
        projectPath: "/project",
      },
    ],
  });
  applySnapshot(fixture.models.worktrees, { worktrees: [options.record ?? currentStatus.record] });
  applyWorktreeOperationCatalogUpdate(fixture.models.worktreeOperations, {
    operations: options.operation ? [options.operation] : [],
  });
  const session = fixture.root.sessionRegistry.load("session-1", "/worktree");
  let revision = 0;
  const publishConversation = (streaming: boolean) =>
    applyConversationUpdate(fixture.models.projectConversation("session-1", "/worktree"), {
      _tag: "Snapshot",
      revision: ++revision,
      snapshot: {
        sessionId: "session-1",
        sessionFile: "/sessions/session-1.jsonl",
        parts: [],
        models: [],
        thinkingLevel: "off",
        availableThinkingLevels: ["off"],
        streaming,
        diagnostics: [],
        commands: [],
        compatibility: { resources: [], diagnostics: [] },
        extensionUi: { statuses: [] },
        tree: [],
      },
    });
  publishConversation(options.streaming ?? false);
  fixture.root.navigationStore.selectProjectSession("session-1");
  fixture.root.projectWorkbenchStore.showLoadedSession("session-1");
  fixture.root.sessionLayoutStore.ensureSession("session-1");
  const Surface = observer(function Surface() {
    const summary = fixture.root.sessionCatalogStore.find("session-1");
    return (
      <section data-slot="session-pane">
        <WorktreePill
          creation={fixture.root.projectSessionCreationStore.worktrees}
          actions={session.worktreeStore}
          record={fixture.root.sessionCatalogStore.managedWorktree("/worktree")}
          resolved={summary?.resolved}
          isFamilyChild={Boolean(
            summary?.familyParentSessionId && summary.familyParentSessionId !== summary.sessionId,
          )}
          sessionId="session-1"
          projectPath="/project"
          landing={fixture.root.projectCatalogStore.find("/project")?.settings.worktreeLanding}
          onConfigured={() =>
            session.conversationSessionStore.composerStore.draftStore.requestFocus()
          }
        />
        <QuakeTerminal
          store={fixture.root.terminalStore}
          retirement={fixture.root.workingDirectoryRetirementStore}
        />
        <ToastHost store={fixture.root.toastStore} />
      </section>
    );
  });
  const view = render(
    <StoreProvider store={fixture.root}>
      <Surface />
      <AutoMergeToggle projectPath="/project" />
    </StoreProvider>,
  );
  return {
    user: userEvent.setup(),
    landing,
    root: fixture.root,
    async setLanding(worktreeLanding: "merge" | "pull-request") {
      await act(async () =>
        applySnapshot(fixture.models.projects, {
          projects: [
            projectRecord({
              path: "/project",
              settings: { ...defaultProjectSettings(), worktreeLanding },
            }),
          ],
        }),
      );
    },
    async publish(
      next: WorktreeLandingOperation | undefined,
      nextStatus: WorktreeStatus | null = currentStatus ?? null,
    ) {
      await act(async () => {
        currentStatus = nextStatus ?? undefined;
        applySnapshot(fixture.models.worktrees, {
          worktrees: nextStatus ? [nextStatus.record] : [],
        });
        applyWorktreeOperationCatalogUpdate(fixture.models.worktreeOperations, {
          operations: next ? [next] : [],
        });
      });
    },
    async publishRecord(record: WorktreeRecord) {
      await act(async () => applySnapshot(fixture.models.worktrees, { worktrees: [record] }));
    },
    async finishTurn(nextStatus: WorktreeStatus) {
      await act(async () => {
        currentStatus = nextStatus;
        publishConversation(false);
      });
    },
    [Symbol.dispose]() {
      view.unmount();
      fixture[Symbol.dispose]();
    },
  };
}
afterEach(cleanup);

describe("manual worktree prompt confirmation", () => {
  it.each([
    ["Run", "run"],
    ["Cancel", "cancel"],
    ["Tool prune and run", "tool-prune"],
  ] as const)("submits %s once for the exact pending request", async (label, decision) => {
    const accepted = gate<void>();
    const confirmAgentPrompt = vi.fn<Client["managedWorktrees"]["confirmAgentPrompt"]>(
      () => accepted.promise,
    );
    using fixture = renderWorktree({
      operation: operation("stalled", {
        confirmAgentPrompts: true,
        pauseReason: "commit",
        promptConfirmation: { id: "confirm-1", estimatedTokens: 120_000 },
      }),
      client: { managedWorktrees: { confirmAgentPrompt } },
    });
    expect(await screen.findByText("Run this agent request?")).toBeTruthy();
    expect(screen.getByText(/120K context tokens/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    await fixture.user.click(screen.getByRole("button", { name: label }));
    expect(confirmAgentPrompt).toHaveBeenCalledExactlyOnceWith({
      workspacePath: "/worktree",
      operationId: "landing-operation",
      confirmationId: "confirm-1",
      decision,
    });
    expect(screen.getByRole("button", { name: label })).toHaveProperty("disabled", true);
    await act(async () => {
      await fixture.publish(
        operation("stalled", {
          confirmAgentPrompts: true,
          pauseReason: "commit",
          promptConfirmation: { id: "confirm-1", estimatedTokens: 120_000, decision },
        }),
      );
      accepted.resolve();
    });
    expect(screen.queryByText("Run this agent request?")).toBeNull();
    expect(confirmAgentPrompt).toHaveBeenCalledOnce();
  });

  it("hides a pending confirmation when navigating away from its recipient", async () => {
    using fixture = renderWorktree({
      operation: operation("stalled", {
        confirmAgentPrompts: true,
        promptConfirmation: { id: "confirm-navigation", estimatedTokens: 120_000 },
      }),
    });
    expect(await screen.findByText("Run this agent request?")).toBeTruthy();
    await act(async () =>
      fixture.root.navigationStore.selectCakeChat(`project-chat:${"c".repeat(64)}`),
    );
    expect(screen.queryByText("Run this agent request?")).toBeNull();
  });

  it("does not show a sibling recipient's countdown in this session", async () => {
    using fixture = renderWorktree({
      operation: operation("stalled", {
        confirmAgentPrompts: true,
        sessionId: "sibling",
        promptConfirmation: { id: "confirm-sibling", estimatedTokens: 120_000 },
      }),
    });
    expect(screen.queryByText("Run this agent request?")).toBeNull();
  });

  it("does not show confirmation for tool operations", async () => {
    using fixture = renderWorktree({ operation: operation("stalled", { pauseReason: "commit" }) });
    expect(await screen.findByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.queryByText("Run this agent request?")).toBeNull();
  });
});

describe("Worktree operation workflows", () => {
  it.each(["failed", "stalled"] as const)(
    "keeps explicit Merge & resolve available after %s automatic intent without readiness",
    async (phase) => {
      const startLanding = vi.fn<Client["managedWorktrees"]["startLanding"]>(async (input) =>
        operation("waiting", { operationId: input.operationId, resolveAfterLanding: true }),
      );
      using fixture = renderWorktree({
        status: status({
          record: {
            ...status().record,
            pendingAutomaticLanding: true,
            pendingStrategy: "preserve",
          },
        }),
        operation: operation(phase, { automatic: true }),
        client: { managedWorktrees: { startLanding } },
      });
      const button = await screen.findByRole("button", { name: "Merge & resolve" });
      expect(button).toHaveProperty("disabled", false);
      await fixture.user.click(button);
      expect(startLanding).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          workspacePath: "/worktree",
          sessionId: "session-1",
          strategy: "preserve",
          commitBeforeLanding: true,
          resolveAfterLanding: true,
        }),
      );
    },
  );

  it.each(["streaming", "canceling"] as const)(
    "does not enable manual takeover of an automatic pause while %s",
    async (blocked) => {
      using fixture = renderWorktree({
        streaming: blocked === "streaming",
        operation: operation("stalled", {
          automatic: true,
          cancellationRequested: blocked === "canceling" ? true : undefined,
        }),
      });
      const store = fixture.root.sessionRegistry.load("session-1", "/worktree").worktreeStore;
      await waitFor(() => expect(store.phase).toBe("paused"));
      expect(screen.getByRole("button", { name: "Merge & resolve" })).toHaveProperty(
        "disabled",
        true,
      );
    },
  );

  it("keeps manual Merge and Merge & resolve when project auto-merge is off", async () => {
    using fixture = renderWorktree();
    expect(fixture.root.autoMergeForProject("/project")?.enabled ?? false).toBe(false);
    expect(await screen.findByRole("button", { name: "Merge" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Merge & resolve" })).toBeDefined();
    expect(screen.getByRole("switch", { name: "Auto-merge: off" })).toBeDefined();
  });

  it("keeps explicit destructive discard confirmation for external projects", async () => {
    const discard = vi.fn<Client["managedWorktrees"]["discard"]>(async () => undefined);
    using fixture = renderWorktree({
      landing: "pull-request",
      client: { managedWorktrees: { discard } },
    });
    await waitFor(() => expect(fixture.landing).toHaveBeenCalled());
    await fixture.user.click(screen.getByRole("button", { name: "Discard & resolve" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/all unmerged work will be lost/)).toBeDefined();
    expect(discard).not.toHaveBeenCalled();
    await fixture.user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(discard).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("reacts to live workflow changes without mutating global auto-merge", async () => {
    using fixture = renderWorktree();
    await waitFor(() => expect(fixture.landing).toHaveBeenCalled());
    await fixture.setLanding("pull-request");
    expect(screen.queryByRole("button", { name: "Merge" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Merge & resolve" })).toBeNull();
    expect(screen.queryByRole("switch", { name: /Auto-merge/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Resolve" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Discard & resolve" })).toBeDefined();
    expect(fixture.root.autoMergeForProject("/project")?.enabled ?? false).toBe(false);
    await fixture.setLanding("merge");
    expect(screen.getByRole("button", { name: "Merge" })).toBeDefined();
    expect(screen.getByRole("switch", { name: "Auto-merge: off" })).toBeDefined();
  });

  it("hides additional-commit landing and stalled merge retry for external projects", async () => {
    using fixture = renderWorktree({
      landing: "pull-request",
      status: status({ record: { ...status().record, state: "landed" } }),
      operation: operation("stalled", { pauseReason: "conflict" }),
    });
    await waitFor(() => expect(fixture.landing).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: /Land.*commit/i })).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeDefined();
    expect(screen.queryByRole("switch", { name: /Auto-merge/ })).toBeNull();
    await fixture.publish(operation("stalled", { kind: "rebase", pauseReason: "rebase-conflict" }));
    expect(await screen.findByRole("button", { name: "Retry" })).toBeDefined();
  });

  it("presents a landed and resolved operation with cleanup warnings without offering another merge", async () => {
    const startLanding = vi.fn<Client["managedWorktrees"]["startLanding"]>(async () =>
      operation("waiting", { resolveAfterLanding: true }),
    );
    const cancelLanding = vi.fn<Client["managedWorktrees"]["cancelLanding"]>(async () => undefined);
    using fixture = renderWorktree({
      client: { managedWorktrees: { startLanding, cancelLanding } },
    });
    await fixture.user.click(await screen.findByRole("button", { name: "Merge & resolve" }));
    await fixture.publish(
      operation("landed", {
        resolveAfterLanding: true,
        cleanupFailures: [
          new ResolutionCleanupFailed({
            operation: "resolveWorkingDirectory",
            resolvedSessionIds: ["session-1"],
            cleanupFailures: [{ workingDirectory: "/worktree", message: "Checkout busy" }],
            message: "Resolved; cleanup failed",
          }),
        ],
      }),
      null,
    );
    expect(
      await screen.findByText(/Sessions resolved; cleanup failed for \/worktree: Checkout busy/),
    ).toBeDefined();
    expect(screen.queryByText("Session merged and resolved")).toBeNull();
    expect(screen.queryByRole("button", { name: "Merge" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Land new commit/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(startLanding).toHaveBeenCalledOnce();
    expect(cancelLanding).toHaveBeenCalledWith({
      operationId: "landing-operation",
      workspacePath: "/worktree",
      intent: "acknowledge",
    });
  });

  it("retains catalog controls during continuation loading and prefers a newly landed catalog record over stale live status", async () => {
    const response = gate<Awaited<ReturnType<Client["managedWorktrees"]["landing"]>>>();
    const landing = vi.fn<Client["managedWorktrees"]["landing"]>(() => response.promise);
    using fixture = renderWorktree({ client: { managedWorktrees: { landing } } });
    expect(screen.getByText("feature")).toBeDefined();
    expect(screen.getByRole("button", { name: "Merge" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Merge & resolve" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(screen.getByRole("button", { name: "Discard & resolve" })).toHaveProperty(
      "disabled",
      false,
    );
    await fixture.publishRecord({ ...status().record, state: "landed" });
    expect(screen.getByRole("button", { name: "Resolve" })).toHaveProperty("disabled", false);
    await act(async () => response.resolve({ status: status() }));
    await waitFor(() => expect(landing).toHaveBeenCalled());
    expect(screen.getByRole("button", { name: "Resolve" })).toHaveProperty("disabled", false);
    expect(screen.queryByRole("button", { name: "Merge" })).toBeNull();
  });

  it("offers resolution instead of merging for a pull-request project", async () => {
    const resolveWorkingDirectory = vi.fn<Client["projectSessions"]["resolveWorkingDirectory"]>(
      async () => ({
        projectPath: "/project",
        workingDirectory: "/worktree",
        resolvedSessionIds: ["session-1"],
        failures: [],
        cleanupFailures: [],
      }),
    );
    using fixture = renderWorktree({
      landing: "pull-request",
      status: status({ targetDirty: true }),
      client: { projectSessions: { resolveWorkingDirectory } },
    });
    await waitFor(() => expect(fixture.landing).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "Merge" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Merge & resolve" })).toBeNull();
    expect(screen.queryByRole("switch", { name: /Auto-merge/ })).toBeNull();
    // The merge target's state is irrelevant when Cake never merges.
    expect(screen.queryByTestId("worktree-target-warning")).toBeNull();
    expect(screen.getByRole("button", { name: "Discard & resolve" })).toBeDefined();
    await fixture.user.click(screen.getByRole("button", { name: "Resolve" }));
    await waitFor(() =>
      expect(resolveWorkingDirectory).toHaveBeenCalledWith(
        { workingDirectory: "/worktree" },
        expect.anything(),
      ),
    );
    await waitFor(() =>
      expect(fixture.root.appShellStore.activeConversation?.sessionId).toBe(
        `project-chat:${"c".repeat(64)}`,
      ),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(fixture.root.toastStore.toasts).toEqual([]);
  });

  it("keeps merge disabled without changes and offers rebase only after the target advances", async () => {
    using fixture = renderWorktree({ status: status({ aheadCount: 0 }), streaming: true });
    await waitFor(() => expect(fixture.landing).toHaveBeenCalled());
    expect(screen.getByRole("button", { name: "Merge" })).toHaveProperty("disabled", true);
    expect(screen.queryByRole("button", { name: "Rebase" })).toBeNull();
    await fixture.finishTurn(status({ behindCount: 1 }));
    expect(await screen.findByRole("button", { name: "Rebase" })).toHaveProperty("disabled", false);
    expect(screen.getByRole("button", { name: "Merge" })).toHaveProperty("disabled", false);
  });

  it("replaces actions with restoration guidance for an archived conversation", async () => {
    using fixture = renderWorktree({ resolved: true });
    await waitFor(() => expect(fixture.landing).toHaveBeenCalled());
    expect(screen.getByRole("status").textContent).toContain(
      "Send a message to restore this session",
    );
    expect(screen.queryByRole("button", { name: "Merge" })).toBeNull();
  });

  it.each(["active", "landed"] as const)(
    "discards a %s child checkout without resolving its family",
    async (state) => {
      const discard = vi.fn<Client["managedWorktrees"]["discard"]>(async () => undefined);
      const resolveWorkingDirectory = vi.fn<Client["projectSessions"]["resolveWorkingDirectory"]>();
      using fixture = renderWorktree({
        child: true,
        status: status({ record: { ...status().record, state }, aheadCount: 0 }),
        client: { managedWorktrees: { discard }, projectSessions: { resolveWorkingDirectory } },
      });
      await waitFor(() => expect(fixture.landing).toHaveBeenCalled());
      expect(screen.queryByRole("button", { name: "Merge & resolve" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Resolve" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Discard & resolve" })).toBeNull();
      await fixture.user.click(screen.getByRole("button", { name: "Discard" }));
      await fixture.user.click(
        within(screen.getByRole("dialog")).getByRole("button", { name: "Discard" }),
      );
      await waitFor(() =>
        expect(discard).toHaveBeenCalledWith(
          expect.objectContaining({ workspacePath: "/worktree", keepBranch: false }),
        ),
      );
      expect(resolveWorkingDirectory).not.toHaveBeenCalled();
    },
  );
  it("refreshes status when a turn ends and immediately submits commit-and-merge for a dirty target", async () => {
    const startLanding = vi.fn<Client["managedWorktrees"]["startLanding"]>(async () =>
      operation("waiting"),
    );
    using fixture = renderWorktree({
      streaming: true,
      status: status({ aheadCount: 0 }),
      client: { managedWorktrees: { startLanding } },
    });
    const merge = await screen.findByRole("button", { name: "Merge" });
    expect(merge).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Merge & resolve" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(screen.getByRole("button", { name: "Discard & resolve" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(screen.getByText("feature")).toBeDefined();
    await fixture.finishTurn(status({ dirtyCount: 2, targetDirty: true }));
    await fixture.user.click(await screen.findByRole("button", { name: "Commit & merge" }));
    expect(startLanding).toHaveBeenCalledOnce();
    expect(screen.getByTestId("worktree-target-warning").getAttribute("aria-label")).toBe(
      "The merge target has uncommitted changes.",
    );
    expect(screen.getByTestId("worktree-target-warning").classList.contains("text-warning")).toBe(
      true,
    );
    expect(startLanding).toHaveBeenCalledWith(
      expect.objectContaining({
        workspacePath: "/worktree",
        sessionId: "session-1",
        strategy: "preserve",
        allowDirtyTarget: true,
        commitBeforeLanding: true,
        resolveAfterLanding: false,
      }),
    );
    expect(screen.getByRole("button", { name: "Committing…" })).toHaveProperty("disabled", true);
    expect(fixture.landing.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it.each([
    { label: "Merge", resolveAfterLanding: false, landed: false },
    { label: "Merge & resolve", resolveAfterLanding: true, landed: false },
    { label: "Land new commit", resolveAfterLanding: false, landed: true },
  ])(
    "submits $label directly for a dirty target and retains native failure presentation",
    async ({ label, resolveAfterLanding, landed }) => {
      const startLanding = vi.fn<Client["managedWorktrees"]["startLanding"]>(async (request) =>
        operation("waiting", {
          operationId: request.operationId,
          allowDirtyTarget: request.allowDirtyTarget,
          resolveAfterLanding: request.resolveAfterLanding,
        }),
      );
      using fixture = renderWorktree({
        status: status({
          targetDirty: true,
          record: { ...status().record, state: landed ? "landed" : "active" },
        }),
        client: { managedWorktrees: { startLanding } },
      });
      await fixture.user.click(await screen.findByRole("button", { name: label }));
      expect(startLanding).toHaveBeenCalledOnce();
      expect(startLanding).toHaveBeenCalledWith(
        expect.objectContaining({
          strategy: "preserve",
          allowDirtyTarget: true,
          commitBeforeLanding: true,
          resolveAfterLanding,
        }),
      );
      expect(
        screen.getByRole("img", { name: "The merge target has uncommitted changes." }),
      ).toBeDefined();

      const request = startLanding.mock.calls[0]![0];
      await fixture.publish(
        operation("failed", {
          operationId: request.operationId,
          allowDirtyTarget: true,
          resolveAfterLanding,
          error: "Git refused to overwrite local changes in README.md",
        }),
      );
      expect(
        await screen.findByText("Git refused to overwrite local changes in README.md"),
      ).toBeDefined();
      expect(screen.getByRole("button", { name: label })).toHaveProperty("disabled", false);
      expect(screen.getByTestId("worktree-target-warning")).toBeDefined();
    },
  );

  it("keeps dirty landed work actionable without inventing new commits", async () => {
    const startLanding = vi.fn<Client["managedWorktrees"]["startLanding"]>(async () =>
      operation("waiting"),
    );
    using fixture = renderWorktree({
      status: status({
        record: { ...status().record, state: "landed", landedSourceCommit: "acknowledged-source" },
        aheadCount: 0,
        behindCount: 18,
        dirtyCount: 1,
        merged: true,
      }),
      client: { managedWorktrees: { startLanding } },
    });
    await fixture.user.click(await screen.findByRole("button", { name: /^Commit & land$/ }));
    expect(screen.queryByText(/new commits? since landing/)).toBeNull();
    expect(screen.queryByRole("button", { name: /^Resolve$/ })).toBeNull();
    expect(startLanding).toHaveBeenCalledWith(
      expect.objectContaining({
        workspacePath: "/worktree",
        commitBeforeLanding: true,
        strategy: "preserve",
        resolveAfterLanding: false,
      }),
    );
  });

  it("keeps a repeat landing active until authoritative completion rather than treating an already-landed record as finished", async () => {
    const cancelLanding = vi.fn<Client["managedWorktrees"]["cancelLanding"]>(async () => undefined);
    const startLanding = vi.fn<Client["managedWorktrees"]["startLanding"]>(async () =>
      operation("waiting"),
    );
    using fixture = renderWorktree({
      status: status({ record: { ...status().record, state: "landed" } }),
      client: { managedWorktrees: { startLanding, cancelLanding } },
    });
    await fixture.user.click(await screen.findByRole("button", { name: "Land new commit" }));
    expect(screen.getByRole("button", { name: "Landing…" })).toHaveProperty("disabled", true);
    expect(screen.getByText("1 new commit since landing")).toBeDefined();
    expect(cancelLanding).not.toHaveBeenCalled();
  });

  it("shows authoritative queue insertion even when the status snapshot predates the reservation", async () => {
    const cancelLanding = vi.fn<Client["managedWorktrees"]["cancelLanding"]>(async () => undefined);
    using fixture = renderWorktree({
      operation: operation("queued"),
      client: { managedWorktrees: { cancelLanding } },
    });
    expect(await screen.findByRole("button", { name: "Waiting to merge…" })).toBeDefined();
    await fixture.user.click(screen.getByRole("button", { name: "Cancel queued merge" }));
    expect(cancelLanding).toHaveBeenCalledWith({
      operationId: "landing-operation",
      workspacePath: "/worktree",
      intent: "cancel",
    });
  });

  it("identifies the blocking landing and updates its phase and identity without calling queued work Git", async () => {
    const queue = {
      blockingOperationId: "blocker-first",
      blockingSessionId: "owner-first",
      blockingPhase: "resolving" as const,
      position: 2,
      queuedAt: 0,
    };
    using fixture = renderWorktree({ operation: operation("queued", { queue }) });
    await screen.findByText(/Queued #2 behind landing blocker-/);
    expect(screen.getByText(/waiting for conflict resolution/)).toBeDefined();
    expect(screen.queryByRole("button", { name: "Merging…" })).toBeNull();
    await fixture.publish(operation("queued", { queue: { ...queue, blockingPhase: "stalled" } }));
    expect(await screen.findByText(/paused; owner action needed/)).toBeDefined();
    await fixture.publish(
      operation("queued", {
        queue: {
          ...queue,
          blockingOperationId: "next-owner",
          position: 1,
          blockingPhase: "landing",
        },
      }),
    );
    expect(await screen.findByText(/Queued #1 behind landing next-own/)).toBeDefined();
    await fixture.publish(operation("landing"));
    expect(await screen.findByRole("button", { name: "Merging…" })).toBeDefined();
    expect(screen.queryByText(/Queued #/)).toBeNull();
    await fixture.publish(operation("failed", { error: "Fixture failure" }));
    expect(await screen.findByText("Fixture failure")).toBeDefined();
    expect(screen.queryByText(/Queued #/)).toBeNull();
  });

  it("reconciles a projection update received during an older in-flight status refresh", async () => {
    const response = gate<Awaited<ReturnType<Client["managedWorktrees"]["landing"]>>>();
    const landing = vi
      .fn<Client["managedWorktrees"]["landing"]>()
      .mockResolvedValueOnce({ status: status() })
      .mockImplementationOnce(() => response.promise)
      .mockResolvedValue({
        status: status({
          record: { ...status().record, state: "landed" },
          aheadCount: 0,
          merged: true,
        }),
      });
    const cancelLanding = vi.fn<Client["managedWorktrees"]["cancelLanding"]>(async () => undefined);
    using fixture = renderWorktree({ client: { managedWorktrees: { landing, cancelLanding } } });
    await screen.findByRole("button", { name: "Merge" });
    await fixture.publish(operation("queued"));
    await waitFor(() => expect(landing).toHaveBeenCalledTimes(2));
    await fixture.publish(
      operation("landed"),
      status({
        record: { ...status().record, state: "landed" },
        aheadCount: 0,
        merged: true,
      }),
    );
    await act(async () => response.resolve({ status: status() }));
    await waitFor(() => expect(landing).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(screen.getByRole("button", { name: "Resolve" })).toBeDefined());
    expect(cancelLanding).toHaveBeenCalledTimes(1);
  });

  it("offers queue cancellation only for the matching authoritative reservation", async () => {
    const current = operation("waiting");
    const cancelLanding = vi.fn<Client["managedWorktrees"]["cancelLanding"]>(async () => undefined);
    using fixture = renderWorktree({
      operation: current,
      status: status({
        landingState: "queued",
        landingOperationId: "another-operation",
        landingQueuePosition: 1,
      }),
      client: { managedWorktrees: { cancelLanding } },
    });
    await screen.findByRole("button", { name: "Merging…" });
    expect(screen.queryByRole("button", { name: "Cancel queued merge" })).toBeNull();
    await fixture.publish(
      { ...current, operationId: "another-operation" },
      status({
        landingState: "queued",
        landingOperationId: "another-operation",
        landingQueuePosition: 1,
      }),
    );
    expect(await screen.findByRole("button", { name: "Waiting to merge…" })).toBeDefined();
    await fixture.user.click(screen.getByRole("button", { name: "Cancel queued merge" }));
    expect(cancelLanding).toHaveBeenCalledWith({
      operationId: "another-operation",
      workspacePath: "/worktree",
      intent: "cancel",
    });
    expect(await screen.findByRole("button", { name: "Merge" })).toBeDefined();
  });

  it.each([false, true])(
    "shows a truthful paused state after Git repair (automatic=%s)",
    async (automatic) => {
      const paused = operation("stalled", {
        pauseReason: "conflict",
        automatic: automatic || undefined,
      });
      using fixture = renderWorktree({
        operation: paused,
        status: status({ dirtyCount: 1, rebasing: true }),
      });
      const label = automatic
        ? "Paused — conflict repair and fresh validation required."
        : "Paused — conflict repair required.";
      expect(await screen.findByText(label)).toBeDefined();
      expect(screen.queryByRole("button", { name: "Resolving conflicts…" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Retry" }) === null).toBe(automatic);
      await fixture.publish({ ...paused }, status());
      const store = fixture.root.sessionRegistry.load("session-1", "/worktree").worktreeStore;
      await act(async () => store.refresh());
      expect(
        await screen.findByText(automatic ? "Paused — fresh validation required." : label),
      ).toBeDefined();
      expect(store.isBusy).toBe(false);
      expect(store.phase).toBe("paused");
      expect(screen.getByRole("button", { name: "Merge" })).toHaveProperty("disabled", !automatic);
    },
  );

  it("presents clean-rebase validation without conflict repair, including validation edits", async () => {
    const validating = operation("validating", { automatic: true, pauseReason: "clean-rebase" });
    using fixture = renderWorktree({ operation: validating });
    await screen.findByRole("button", { name: "Merge" });
    const store = fixture.root.sessionRegistry.load("session-1", "/worktree").worktreeStore;
    await waitFor(() => expect(store.phase).toBe("validating"));
    expect(store.isBusy).toBe(true);
    expect(screen.queryByRole("button", { name: "Resolving conflicts…" })).toBeNull();
    await fixture.publish({ ...validating, phase: "stalled" }, status({ dirtyCount: 1 }));
    expect(await screen.findByText("Paused — fresh validation required.")).toBeDefined();
    expect(screen.queryByText(/conflict repair/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("retries and dismisses a stalled operation through main-process commands", async () => {
    const retryLanding = vi.fn<Client["managedWorktrees"]["retryLanding"]>(async () =>
      operation("resolving", { operationId: "retry-operation" }),
    );
    const cancelLanding = vi.fn<Client["managedWorktrees"]["cancelLanding"]>(async () => undefined);
    using fixture = renderWorktree({
      operation: operation("stalled", { pauseReason: "conflict" }),
      client: { managedWorktrees: { retryLanding, cancelLanding } },
    });
    await fixture.user.click(await screen.findByRole("button", { name: "Retry" }));
    expect(retryLanding).toHaveBeenCalledWith(
      expect.objectContaining({ workspacePath: "/worktree", sessionId: "session-1" }),
    );
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    await fixture.publish(
      operation("stalled", { operationId: "retry-operation", pauseReason: "conflict" }),
    );
    await fixture.user.click(await screen.findByRole("button", { name: "Dismiss" }));
    expect(cancelLanding).toHaveBeenCalledWith({
      operationId: "retry-operation",
      workspacePath: "/worktree",
      intent: "cancel",
    });
    expect(screen.getByRole("button", { name: "Merge" })).toHaveProperty("disabled", false);
  });

  it("keeps clicked merge-and-resolve quiet through a commit pause even when acknowledgment fails", async () => {
    const startLanding = vi.fn<Client["managedWorktrees"]["startLanding"]>(async () =>
      operation("waiting", { resolveAfterLanding: true }),
    );
    const cancelLanding = vi.fn<Client["managedWorktrees"]["cancelLanding"]>(async () => {
      throw new Error("Acknowledgment transport failed");
    });
    const retryLanding = vi.fn<Client["managedWorktrees"]["retryLanding"]>(async () =>
      operation("waiting", { resolveAfterLanding: true }),
    );
    using fixture = renderWorktree({
      client: { managedWorktrees: { startLanding, cancelLanding, retryLanding } },
    });
    await fixture.user.click(await screen.findByRole("button", { name: "Merge & resolve" }));
    expect(startLanding).toHaveBeenCalledWith(
      expect.objectContaining({ resolveAfterLanding: true }),
    );
    await fixture.publish(
      operation("stalled", { pauseReason: "commit", resolveAfterLanding: true }),
    );
    expect(await screen.findByText("Paused — commit required.")).toBeDefined();
    expect(screen.queryByRole("button", { name: "Committing…" })).toBeNull();
    await fixture.user.click(screen.getByRole("button", { name: "Retry" }));
    expect(retryLanding).toHaveBeenCalledOnce();
    await fixture.publish(operation("landed", { resolveAfterLanding: true }), null);
    await waitFor(() =>
      expect(cancelLanding).toHaveBeenCalledWith({
        operationId: "landing-operation",
        workspacePath: "/worktree",
        intent: "acknowledge",
      }),
    );
    expect(screen.queryByText("Session merged and resolved")).toBeNull();
  });

  it("reconciles a rebase that finishes before its accepted start response arrives", async () => {
    const accepted = gate<WorktreeLandingOperation>();
    const startRebase = vi.fn<Client["managedWorktrees"]["startRebase"]>(() => accepted.promise);
    const cancelLanding = vi.fn<Client["managedWorktrees"]["cancelLanding"]>(async () => undefined);
    using fixture = renderWorktree({
      status: status({ behindCount: 1 }),
      client: { managedWorktrees: { startRebase, cancelLanding } },
    });
    await fixture.user.click(await screen.findByRole("button", { name: "Rebase" }));
    expect(startRebase).toHaveBeenCalledWith(
      expect.objectContaining({ workspacePath: "/worktree", sessionId: "session-1" }),
    );
    await fixture.publish(operation("complete", { kind: "rebase", strategy: undefined }));
    await act(async () =>
      accepted.resolve(operation("rebasing", { kind: "rebase", strategy: undefined })),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Rebase" })).toHaveProperty("disabled", false),
    );
    expect(screen.queryByText("Rebasing…")).toBeNull();
    expect(cancelLanding).toHaveBeenCalledWith({
      operationId: "landing-operation",
      workspacePath: "/worktree",
      intent: "acknowledge",
    });
  });

  it("does not discard or close terminals when retirement of running programs is cancelled", async () => {
    const discard = vi.fn<Client["managedWorktrees"]["discard"]>(async () => undefined);
    const closeWorkingDirectory = vi.fn<Client["terminals"]["closeWorkingDirectory"]>(
      async () => undefined,
    );
    using fixture = renderWorktree({
      client: {
        managedWorktrees: { discard },
        terminals: {
          workingDirectoryStatus: async () => ({ runningProgramCount: 2 }),
          closeWorkingDirectory,
        },
      },
    });
    await fixture.user.click(await screen.findByRole("button", { name: "Discard & resolve" }));
    await fixture.user.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Discard & resolve" }),
    );
    const retirement = await screen.findByRole("dialog", {
      name: "Retire and stop running programs?",
    });
    await fixture.user.click(within(retirement).getByRole("button", { name: "Cancel" }));
    expect(discard).not.toHaveBeenCalled();
    expect(closeWorkingDirectory).not.toHaveBeenCalled();
    expect(screen.getByText("feature")).toBeDefined();
    expect(screen.getByRole("button", { name: "Merge" })).toHaveProperty("disabled", false);
  });

  it("shows start failures and lets the user submit another landing", async () => {
    const startLanding = vi
      .fn<Client["managedWorktrees"]["startLanding"]>()
      .mockRejectedValueOnce(new Error("Landing service unavailable"))
      .mockResolvedValueOnce(operation("waiting"));
    using fixture = renderWorktree({
      status: status({ targetDirty: true }),
      client: { managedWorktrees: { startLanding } },
    });
    await fixture.user.click(await screen.findByRole("button", { name: "Merge" }));
    expect(await screen.findByText("Landing service unavailable")).toBeDefined();
    await fixture.user.click(screen.getByRole("button", { name: "Merge" }));
    expect(startLanding).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("Landing service unavailable")).toBeNull();
    expect(screen.getByRole("button", { name: "Merging…" })).toHaveProperty("disabled", true);
  });
});

describe("Existing worktree picker", () => {
  const candidates = [
    { path: "/worktrees/run-pages", branch: "agent/run-pages-53c116", title: "Run pages via API" },
    { path: "/worktrees/capacity", branch: "agent/team-capacity-c48410", title: "Team capacity" },
    { path: "/worktrees/stats", branch: "agent/stats-whitespace", title: "Stats page whitespace" },
  ];
  function renderPicker() {
    const fixture = createRendererStoreFixture({
      projects: [projectRecord({ path: "/project" })],
      sessions: [
        sessionSummary({ sessionId: "draft", projectPath: "/project" }),
        ...candidates.map((candidate, index) =>
          sessionSummary({
            sessionId: `worktree-session-${index}`,
            projectPath: "/project",
            workingDirectory: candidate.path,
            title: candidate.title,
          }),
        ),
      ],
    });
    applySnapshot(fixture.models.worktrees, {
      worktrees: candidates.map((candidate, index) => ({
        projectPath: "/project",
        worktreePath: candidate.path,
        branch: candidate.branch,
        baseBranch: "main",
        createdAt: `2026-01-0${3 - index}T00:00:00.000Z`,
        state: "active",
      })),
    });
    const session = fixture.root.sessionRegistry.load("draft", "/project");
    const creation = fixture.root.projectSessionCreationStore.worktrees;
    const view = render(
      <WorktreePill
        creation={creation}
        actions={session.worktreeStore}
        sessionId="draft"
        projectPath="/project"
        configurationMode="new-session"
        onConfigured={() => undefined}
      />,
    );
    return {
      user: userEvent.setup(),
      creation,
      async open() {
        await this.user.click(screen.getByRole("button", { name: "Choose existing worktree" }));
        const filter = await screen.findByRole("combobox", { name: "Filter worktrees" });
        await waitFor(() => expect(document.activeElement).toBe(filter));
        return filter;
      },
      titles: () =>
        within(screen.getByRole("listbox", { name: "Worktrees" }))
          .getAllByRole("option")
          .map((option) => option.title.split("\n")[0]),
      activeTitle: () => screen.getByRole("option", { selected: true }).title.split("\n")[0] ?? "",
      [Symbol.dispose]() {
        view.unmount();
        fixture[Symbol.dispose]();
      },
    };
  }

  it("filters by title or branch without case sensitivity and reports no matches", async () => {
    using fixture = renderPicker();
    const filter = await fixture.open();
    expect(fixture.titles()).toEqual([
      "Run pages via API",
      "Team capacity",
      "Stats page whitespace",
    ]);
    expect(screen.getByRole("option", { name: /Team capacity/ }).title).toBe(
      "Team capacity\nteam-capacity-c48410 → main",
    );

    await fixture.user.type(filter, "PAGE");
    expect(fixture.titles()).toEqual(["Run pages via API", "Stats page whitespace"]);

    await fixture.user.clear(filter);
    await fixture.user.type(filter, "c48410");
    expect(fixture.titles()).toEqual(["Team capacity"]);

    await fixture.user.clear(filter);
    await fixture.user.type(filter, "agent");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("No matching worktrees");
  });

  it("moves through filtered results with arrow keys and selects with Enter", async () => {
    using fixture = renderPicker();
    const filter = await fixture.open();
    await fixture.user.type(filter, "a");
    expect(fixture.activeTitle()).toBe("Run pages via API");
    await fixture.user.keyboard("{ArrowDown}");
    expect(fixture.activeTitle()).toBe("Team capacity");
    expect(filter.getAttribute("aria-activedescendant")).toBe(
      screen.getByRole("option", { selected: true }).id,
    );
    await fixture.user.keyboard("{ArrowUp}{ArrowUp}");
    expect(fixture.activeTitle()).toBe("Stats page whitespace");
    await fixture.user.keyboard("{ArrowDown}{ArrowDown}{Enter}");

    expect(fixture.creation.choice("draft")).toEqual({
      kind: "reuse",
      worktreePath: "/worktrees/capacity",
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByRole("button", { name: "Choose existing worktree" }).textContent).toContain(
      "Team capacity · team-capacity-c48410",
    );

    // Reopening starts from the current choice and marks it.
    await fixture.open();
    expect(fixture.activeTitle()).toBe("Team capacity");
    expect(screen.getByRole("option", { name: /Team capacity/ }).getAttribute("aria-checked")).toBe(
      "true",
    );
  });

  it("clears the filter on the first Escape and closes on the second", async () => {
    using fixture = renderPicker();
    const filter = await fixture.open();
    await fixture.user.type(filter, "missing");
    await fixture.user.keyboard("{Escape}");
    expect(screen.getByRole("dialog", { name: "Existing worktrees" })).toBeDefined();
    expect((filter as HTMLInputElement).value).toBe("");
    expect(fixture.titles()).toHaveLength(3);

    await fixture.user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Choose existing worktree" }),
    );
    expect(fixture.creation.choice("draft")).toEqual({ kind: "current" });
  });
});
