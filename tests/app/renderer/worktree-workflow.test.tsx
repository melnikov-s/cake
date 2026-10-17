/** @vitest-environment jsdom */
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { applySnapshot } from "r-state-tree";
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
    client?: TestClientOverrides;
  } = {},
) {
  let currentStatus: WorktreeStatus | undefined = options.status ?? status();
  const landing = vi.fn<Client["managedWorktrees"]["landing"]>(async () => ({
    status: currentStatus,
  }));
  const fixture = createRendererStoreFixture({
    projects: [projectRecord({ path: "/project" })],
    sessions: [
      sessionSummary({
        sessionId: "session-1",
        projectPath: "/project",
        workingDirectory: "/worktree",
      }),
    ],
    client: {
      ...options.client,
      managedWorktrees: { landing, ...options.client?.managedWorktrees },
      terminals: {
        workingDirectoryStatus: async () => ({ runningProgramCount: 0 }),
        closeWorkingDirectory: async () => undefined,
        ...options.client?.terminals,
      },
    },
  });
  applySnapshot(fixture.models.worktrees, { worktrees: [currentStatus.record] });
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
  fixture.root.appShellStore.selectProjectSession("session-1");
  fixture.root.projectWorkbenchStore.showLoadedSession("session-1");
  fixture.root.sessionLayoutStore.ensureSession("session-1");
  const view = render(
    <>
      <WorktreePill
        creation={fixture.root.projectSessionCreationStore.worktrees}
        actions={session.worktreeStore}
        sessionId="session-1"
        projectPath="/project"
        onConfigured={() =>
          session.conversationSessionStore.composerStore.draftStore.requestFocus()
        }
      />
      <QuakeTerminal
        store={fixture.root.terminalStore}
        retirement={fixture.root.workingDirectoryRetirementStore}
      />
      <ToastHost store={fixture.root.toastStore} />
    </>,
  );
  return {
    user: userEvent.setup(),
    landing,
    async publish(
      next: WorktreeLandingOperation | undefined,
      nextStatus: WorktreeStatus | null = currentStatus ?? null,
    ) {
      await act(async () => {
        currentStatus = nextStatus ?? undefined;
        applyWorktreeOperationCatalogUpdate(fixture.models.worktreeOperations, {
          operations: next ? [next] : [],
        });
      });
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

describe("Worktree operation workflows", () => {
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
    expect(await screen.findByText("Session merged and resolved")).toBeDefined();
    expect(
      await screen.findByText(/Sessions resolved; cleanup failed for \/worktree: Checkout busy/),
    ).toBeDefined();
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
    expect(screen.getByText("feature")).toBeDefined();
    await fixture.finishTurn(status({ dirtyCount: 2, targetDirty: true }));
    await fixture.user.click(await screen.findByRole("button", { name: "Commit & merge" }));
    expect(startLanding).toHaveBeenCalledOnce();
    expect(screen.getByTestId("worktree-target-warning").getAttribute("aria-label")).toBe(
      "The merge target has uncommitted changes.",
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
    await fixture.publish(operation("landed"));
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

  it("preserves merge-and-resolve intent through a commit pause and reports completion even when acknowledgment fails", async () => {
    const startLanding = vi.fn<Client["managedWorktrees"]["startLanding"]>(async () =>
      operation("waiting", { resolveAfterLanding: true }),
    );
    const cancelLanding = vi.fn<Client["managedWorktrees"]["cancelLanding"]>(async () => {
      throw new Error("Acknowledgment transport failed");
    });
    using fixture = renderWorktree({
      client: { managedWorktrees: { startLanding, cancelLanding } },
    });
    await fixture.user.click(await screen.findByRole("button", { name: "Merge & resolve" }));
    expect(startLanding).toHaveBeenCalledWith(
      expect.objectContaining({ resolveAfterLanding: true }),
    );
    await fixture.publish(
      operation("stalled", { pauseReason: "commit", resolveAfterLanding: true }),
    );
    expect(await screen.findByRole("button", { name: "Committing…" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Retry" })).toBeDefined();
    await fixture.publish(operation("landed", { resolveAfterLanding: true }), null);
    expect(await screen.findByText("Session merged and resolved")).toBeDefined();
    expect(cancelLanding).toHaveBeenCalledWith({
      operationId: "landing-operation",
      workspacePath: "/worktree",
      intent: "acknowledge",
    });
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
