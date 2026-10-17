/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { applySnapshot } from "r-state-tree";
import { StoreProvider } from "r-state-tree/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultApplicationState } from "../../../src/contracts/application/application-data";
import type { ConversationSnapshot } from "../../../src/contracts/conversations/conversation-data";
import type { WorktreeRecord } from "../../../src/contracts/worktrees/managed-worktree-data";
import type { Client } from "../../../src/renderer/client/Client";
import { App } from "../../../src/renderer/components/app";
import { applyConversationUpdate } from "../../../src/renderer/reducers/ConversationReducer";
import { projectRecord, sessionSummary } from "./fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "./renderer-store-fixture";
import type { TestClientOverrides } from "./test-client";

const record: WorktreeRecord = {
  projectPath: "/project",
  worktreePath: "/worktree",
  branch: "agent/feature",
  baseBranch: "main",
  state: "landed",
  createdAt: "2026-01-01T00:00:00.000Z",
};
function snapshot(sessionId: string): ConversationSnapshot {
  return {
    sessionId,
    sessionFile: `/sessions/${sessionId}.jsonl`,
    parts: [],
    models: [],
    thinkingLevel: "off",
    availableThinkingLevels: ["off"],
    streaming: false,
    diagnostics: [],
    commands: [],
    compatibility: { resources: [], diagnostics: [] },
    extensionUi: { statuses: [] },
    tree: [],
  };
}
function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
function renderWorkbench(client: TestClientOverrides, resolved = false) {
  const summaries = ["one", "two"].map((sessionId) =>
    sessionSummary({
      sessionId,
      title: `${sessionId} conversation`,
      projectPath: "/project",
      projectName: "Project",
      workingDirectory: "/worktree",
      resolved,
    }),
  );
  const fixture = createRendererStoreFixture({
    projects: [projectRecord({ path: "/project", name: "Project" })],
    sessions: summaries,
    client: {
      ...client,
      workspaces: {
        inspect: async (request) => ({ ...request, trustRequired: false }),
        registerProject: async () => defaultApplicationState(),
        loadStagedSlashCommands: async () => [],
        ...client.workspaces,
      },
      projectSessions: { open: async () => undefined, ...client.projectSessions },
      terminals: {
        workingDirectoryStatus: async () => ({ runningProgramCount: 0 }),
        closeWorkingDirectory: async () => undefined,
        ...client.terminals,
      },
    },
  });
  applySnapshot(fixture.models.worktrees, { worktrees: [record] });
  for (const summary of summaries) {
    fixture.root.sessionRegistry.load(summary.sessionId, summary.workingDirectory);
    applyConversationUpdate(
      fixture.models.projectConversation(summary.sessionId, summary.workingDirectory),
      { _tag: "Snapshot", revision: 1, snapshot: snapshot(summary.sessionId) },
    );
  }
  if (resolved) fixture.root.appShellStore.previewResolvedProjectSession("one");
  else fixture.root.appShellStore.selectProjectSession("one");
  fixture.root.projectWorkbenchStore.showLoadedSession("one");
  fixture.root.sessionLayoutStore.ensureSession("one");
  const view = render(
    <StoreProvider store={fixture.root}>
      <App />
    </StoreProvider>,
  );
  return {
    user: userEvent.setup(),
    [Symbol.dispose]() {
      view.unmount();
      fixture[Symbol.dispose]();
    },
  };
}
beforeEach(() => {
  vi.stubGlobal("PointerEvent", MouseEvent);
  Object.defineProperty(SVGElement.prototype, "getBBox", {
    configurable: true,
    value: () => ({ x: 0, y: 0, width: 24, height: 24 }),
  });
  vi.stubGlobal("matchMedia", (query: string): MediaQueryList => ({
    media: query,
    matches: query === "(prefers-reduced-motion: reduce)",
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => true,
  }));
});
afterEach(() => {
  cleanup();
  Reflect.deleteProperty(SVGElement.prototype, "getBBox");
  vi.unstubAllGlobals();
});

describe("Workbench workflow", () => {
  it("cleans up main-selected worktrees rather than stale renderer candidates", async () => {
    const inspectResolvedForProject = vi.fn<
      Client["managedWorktrees"]["inspectResolvedForProject"]
    >(async () => ({ projectPath: "/project", workingDirectories: ["/eligible"] }));
    const discardResolvedForProject = vi.fn<
      Client["managedWorktrees"]["discardResolvedForProject"]
    >(async () => ({
      projectPath: "/project",
      discardedWorkingDirectories: ["/eligible"],
      failures: [],
    }));
    const closeWorkingDirectory = vi.fn<Client["terminals"]["closeWorkingDirectory"]>(
      async () => undefined,
    );
    using fixture = renderWorkbench(
      {
        electron: { showProjectContextMenu: async () => "delete-resolved-worktrees" },
        managedWorktrees: { inspectResolvedForProject, discardResolvedForProject },
        terminals: { closeWorkingDirectory },
      },
      true,
    );
    fireEvent.contextMenu(screen.getByRole("button", { name: "Open Project Chat for project" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Delete resolved worktrees?" });
    expect(within(dialog).getByText(/1 landed worktree/)).toBeDefined();
    await fixture.user.click(within(dialog).getByRole("button", { name: "Delete worktrees" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(inspectResolvedForProject).toHaveBeenCalledWith(
      "/project",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(closeWorkingDirectory).toHaveBeenCalledWith(
      "/eligible",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(closeWorkingDirectory).toHaveBeenCalledTimes(1);
    expect(discardResolvedForProject).toHaveBeenCalledWith(
      "/project",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(closeWorkingDirectory.mock.invocationCallOrder[0]).toBeLessThan(
      discardResolvedForProject.mock.invocationCallOrder[0]!,
    );
  });

  it("uses the authoritative resolved-session list to retire the active worktree and return to the project", async () => {
    const resolveWorkingDirectory = vi.fn<Client["projectSessions"]["resolveWorkingDirectory"]>(
      async () => ({
        projectPath: "/project",
        workingDirectory: "/worktree",
        resolvedSessionIds: ["one", "two"],
        failures: [],
        cleanupFailures: [],
      }),
    );
    using fixture = renderWorkbench({ projectSessions: { resolveWorkingDirectory } });
    await fixture.user.click(screen.getByRole("button", { name: /^two conversation / }));
    await fixture.user.click(screen.getByRole("button", { name: /^one conversation / }));
    await fixture.user.click(screen.getByRole("button", { name: "Resolve" }));
    expect(await screen.findByText("New chat")).toBeDefined();
    expect(screen.getByPlaceholderText("Ask Cake to work in Project…")).toBeDefined();
    expect(resolveWorkingDirectory).toHaveBeenCalledWith(
      { workingDirectory: "/worktree" },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("does not replace a sibling conversation selected while resolution is pending", async () => {
    const pending =
      deferred<Awaited<ReturnType<Client["projectSessions"]["resolveWorkingDirectory"]>>>();
    const resolveWorkingDirectory = vi.fn<Client["projectSessions"]["resolveWorkingDirectory"]>(
      () => pending.promise,
    );
    using fixture = renderWorkbench({ projectSessions: { resolveWorkingDirectory } });
    expect(screen.getByRole("button", { name: "Open VS Code" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Open workspace changes in VS Code" })).toBeDefined();
    await fixture.user.click(screen.getByRole("button", { name: "Resolve" }));
    await waitFor(() => expect(resolveWorkingDirectory).toHaveBeenCalledOnce());
    await fixture.user.click(screen.getByRole("button", { name: /^two conversation / }));
    await act(async () =>
      pending.resolve({
        projectPath: "/project",
        workingDirectory: "/worktree",
        resolvedSessionIds: ["one", "two"],
        failures: [],
        cleanupFailures: [],
      }),
    );
    expect(screen.getByRole("combobox", { name: "Message" })).toBeDefined();
    expect(screen.getAllByText("two conversation").length).toBeGreaterThan(1);
  });

  it("hides editor and workspace-change actions when navigating to a resolved conversation", async () => {
    const open = vi.fn<Client["vscode"]["open"]>(async () => undefined);
    const openSourceControl = vi.fn<Client["vscode"]["openSourceControl"]>(async () => undefined);
    using fixture = renderWorkbench({ vscode: { open, openSourceControl } }, true);
    await fixture.user.click(screen.getByRole("button", { name: "Expand Resolved" }));
    await fixture.user.click(
      screen.getAllByRole("button", { name: "Expand Project resolved" })[0]!,
    );
    await fixture.user.click(screen.getByRole("button", { name: /^two conversation / }));
    expect(screen.getAllByText("two conversation").length).toBeGreaterThan(1);
    expect(screen.queryByRole("button", { name: "Open VS Code" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Open workspace changes in VS Code" })).toBeNull();
    expect(open).not.toHaveBeenCalled();
    expect(openSourceControl).not.toHaveBeenCalled();
  });
});
