/** @vitest-environment jsdom */
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { applySnapshot } from "r-state-tree";
import { StoreProvider } from "r-state-tree/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationSnapshot } from "../../../src/domain/conversations/conversation-data";
import type { WorktreeRecord } from "../../../src/domain/worktrees/managed-worktree-data";
import type { Client } from "../../../src/renderer/client/Client";
import { App } from "../../../src/renderer/components/app";
import { applyConversationUpdate } from "../../../src/renderer/reducers/ConversationReducer";
import { projectRecord, sessionSummary } from "./fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "./renderer-store-fixture";
import type { TestClientOverrides } from "./test-client";

function snapshot(sessionId: string): ConversationSnapshot {
  return {
    sessionId,
    sessionFile: `/sessions/${sessionId}.jsonl`,
    parts: [
      {
        id: "assistant-part",
        entryId: "assistant-entry",
        kind: "text",
        role: "assistant",
        text: "Ready to continue",
        status: "complete",
      },
    ],
    models: [],
    thinkingLevel: "off",
    availableThinkingLevels: ["off"],
    streaming: false,
    diagnostics: [],
    commands: [],
    compatibility: { resources: [], diagnostics: [] },
    extensionUi: { statuses: [] },
    tree: [
      {
        id: "assistant-entry",
        type: "message",
        messageRole: "assistant",
        preview: "Ready to continue",
        active: true,
      },
    ],
  };
}
function worktree(worktreePath: string): WorktreeRecord {
  return {
    projectPath: "/project",
    worktreePath,
    branch: "agent/continue-work",
    baseBranch: "main",
    createdAt: "2026-01-01T00:00:00.000Z",
    state: "active",
  };
}
function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
function renderContinuation(client: TestClientOverrides, managed = true) {
  const workingDirectory = managed ? "/current-worktree" : "/project";
  const source = sessionSummary({
    sessionId: "source",
    title: "Source conversation",
    projectPath: "/project",
    projectName: "Project",
    workingDirectory,
  });
  const fixture = createRendererStoreFixture({
    projects: [projectRecord({ path: "/project", name: "Project" })],
    sessions: [source],
    client: {
      ...client,
      electron: { setFullscreenSurfaceOpen: async () => undefined, ...client.electron },
      workspaces: { loadStagedSlashCommands: async () => [], ...client.workspaces },
    },
  });
  if (managed) applySnapshot(fixture.models.worktrees, { worktrees: [worktree(workingDirectory)] });
  fixture.root.sessionRegistry.load("source", workingDirectory);
  applyConversationUpdate(fixture.models.projectConversation("source", workingDirectory), {
    _tag: "Snapshot",
    revision: 1,
    snapshot: snapshot("source"),
  });
  fixture.root.appShellStore.selectProjectSession("source");
  fixture.root.projectWorkbenchStore.showLoadedSession("source");
  fixture.root.sessionLayoutStore.ensureSession("source");
  const view = render(
    <StoreProvider store={fixture.root}>
      <StoreProvider store={fixture.root.fullscreenSurfaceStore}>
        <App />
      </StoreProvider>
    </StoreProvider>,
  );
  return {
    user: userEvent.setup(),
    async hydrateFork(path: string) {
      await act(async () => {
        applySnapshot(fixture.models.sessionCatalog, {
          sessions: [
            source,
            sessionSummary({
              sessionId: "forked",
              title: "Forked conversation",
              projectPath: "/project",
              projectName: "Project",
              workingDirectory: path,
            }),
          ],
          resolvedHasMoreByProject: {},
        });
        applyConversationUpdate(fixture.models.projectConversation("forked", path), {
          _tag: "Snapshot",
          revision: 1,
          snapshot: snapshot("forked"),
        });
      });
    },
    [Symbol.dispose]() {
      view.unmount();
      fixture[Symbol.dispose]();
    },
  };
}
async function openFork(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Session tree" }));
  await user.click(screen.getByRole("button", { name: "Fork from Ready to continue" }));
  return screen.findByRole("dialog", { name: "Fork this conversation" });
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

describe("Session continuation workflow", () => {
  it("forks into the project root and selects the identity-only child before runtime setup finishes", async () => {
    const pendingOpen = deferred<void>();
    const open = vi.fn<Client["projectSessions"]["open"]>(() => pendingOpen.promise);
    const fork = vi.fn<Client["projectSessions"]["fork"]>(async () => ({ sessionId: "forked" }));
    const create = vi.fn<Client["managedWorktrees"]["create"]>();
    using fixture = renderContinuation({
      projectSessions: { fork, open },
      managedWorktrees: { create },
    });
    const dialog = await openFork(fixture.user);
    await fixture.user.click(
      within(dialog).getByRole("button", { name: "Use the project root (no worktree)" }),
    );
    await fixture.user.click(within(dialog).getByRole("button", { name: "Fork conversation" }));
    expect(await screen.findByText("New chat")).toBeDefined();
    expect(screen.getByRole("combobox", { name: "Message" })).toBeDefined();
    expect(fork).toHaveBeenCalledWith(
      {
        sessionId: "source",
        workingDirectory: "/current-worktree",
        entryId: "assistant-entry",
        resolveSource: false,
        destinationWorkingDirectory: "/project",
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(create).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledWith(
      { sessionId: "forked", workingDirectory: "/project" },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    await fixture.hydrateFork("/project");
    await act(async () => pendingOpen.resolve());
    expect(screen.getAllByText("Forked conversation").length).toBeGreaterThan(1);
  });

  it("keeps the source usable while preparing a new worktree, then forks into that checkout", async () => {
    const pendingCreate = deferred<WorktreeRecord>();
    const create = vi.fn<Client["managedWorktrees"]["create"]>(() => pendingCreate.promise);
    const fork = vi.fn<Client["projectSessions"]["fork"]>(async () => ({ sessionId: "forked" }));
    const open = vi.fn<Client["projectSessions"]["open"]>(async () => undefined);
    using fixture = renderContinuation({
      managedWorktrees: { create },
      projectSessions: { fork, open },
    });
    const dialog = await openFork(fixture.user);
    await fixture.user.click(within(dialog).getByRole("button", { name: "Create a new worktree" }));
    const name = within(dialog).getByRole("textbox", { name: /^Worktree name/ });
    await fixture.user.clear(name);
    await fixture.user.type(name, "follow-up");
    await fixture.user.click(
      within(dialog).getByRole("switch", { name: "Resolve the parent conversation after forking" }),
    );
    await fixture.user.click(within(dialog).getByRole("button", { name: "Fork conversation" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getAllByText("Source conversation").length).toBeGreaterThan(1);
    expect(screen.getByRole("combobox", { name: "Message" }).hasAttribute("disabled")).toBe(false);
    expect(fork).not.toHaveBeenCalled();
    await act(async () => pendingCreate.resolve(worktree("/created-worktree")));
    expect(await screen.findByText("New chat")).toBeDefined();
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "/project",
        worktreeName: "follow-up",
        backgroundSetup: true,
        baseWorktreePath: undefined,
      }),
    );
    expect(fork).toHaveBeenCalledWith(
      expect.objectContaining({
        destinationWorkingDirectory: "/created-worktree",
        resolveSource: true,
      }),
      expect.anything(),
    );
    await fixture.hydrateFork("/created-worktree");
  });

  it("disables child-worktree branching outside a managed worktree and cancels without forking", async () => {
    const fork = vi.fn<Client["projectSessions"]["fork"]>();
    using fixture = renderContinuation({ projectSessions: { fork } }, false);
    const dialog = await openFork(fixture.user);
    const branch = within(dialog).getByRole("button", { name: "Branch off the current worktree" });
    expect(branch.hasAttribute("disabled")).toBe(true);
    await fixture.user.click(branch);
    expect(
      within(dialog)
        .getByRole("button", { name: "Use the current working directory" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    await fixture.user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(fork).not.toHaveBeenCalled();
    expect(screen.getAllByText("Source conversation").length).toBeGreaterThan(1);
  });

  it("tool-compacts the active session through the composer without a fork dialog", async () => {
    const toolCompact = vi.fn<Client["projectSessions"]["toolCompact"]>(async () => ({
      sessionId: "source",
    }));
    const fork = vi.fn<Client["projectSessions"]["fork"]>();
    using fixture = renderContinuation({ projectSessions: { toolCompact, fork } });
    await fixture.user.type(
      screen.getByRole("combobox", { name: "Message" }),
      "/toolcompact Continue cleanly",
    );
    await fixture.user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect(toolCompact).toHaveBeenCalledWith(
        {
          sessionId: "source",
          workingDirectory: "/current-worktree",
          entryId: "assistant-entry",
          prompt: "Continue cleanly",
        },
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      ),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(fork).not.toHaveBeenCalled();
    expect(screen.getAllByText("Source conversation").length).toBeGreaterThan(1);
  });
});
