/** @vitest-environment jsdom */
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { applySnapshot } from "r-state-tree";
import { StoreProvider } from "r-state-tree/react";
import { VirtuosoMockContext } from "react-virtuoso";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TurnId,
  type ConversationSnapshot,
} from "../../../src/contracts/conversations/conversation-data";
import type { WorktreeRecord } from "../../../src/contracts/worktrees/managed-worktree-data";
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
function forkedSummary(workingDirectory: string) {
  return sessionSummary({
    sessionId: "forked",
    title: "Forked conversation",
    projectPath: "/project",
    projectName: "Project",
    workingDirectory,
  });
}
/** The backend writes the fork before returning, so the exact-ID lookup finds it once released. */
function deferredForkLookup(workingDirectory: string) {
  const pending = deferred<void>();
  const lookup = vi.fn<Client["projectSessions"]["lookup"]>(async ({ sessionId }) => {
    if (sessionId !== "forked") throw new Error(`Cake could not find Project Session ${sessionId}`);
    await pending.promise;
    return forkedSummary(workingDirectory);
  });
  return { lookup, resolve: () => act(async () => pending.resolve()) };
}
function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Value>((complete, fail) => {
    resolve = complete;
    reject = fail;
  });
  return { promise, resolve, reject };
}
function renderContinuation(client: TestClientOverrides, managed = true) {
  const workingDirectory = managed ? "/current-worktree" : "/project";
  let source = sessionSummary({
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
  fixture.root.navigationStore.selectProjectSession("source");
  fixture.root.projectWorkbenchStore.showLoadedSession("source");
  fixture.root.sessionLayoutStore.ensureSession("source");
  const view = render(
    <StoreProvider store={fixture.root}>
      <StoreProvider store={fixture.root.fullscreenSurfaceStore}>
        <VirtuosoMockContext.Provider value={{ viewportHeight: 800, itemHeight: 100 }}>
          <App />
        </VirtuosoMockContext.Provider>
      </StoreProvider>
    </StoreProvider>,
  );
  return {
    user: userEvent.setup(),
    async interruptAgent() {
      await act(async () =>
        fixture.root.projectWorkbenchStore.applyAgentAvailability({
          revision: 1,
          global: { state: "unavailable", reason: "Agent stopped" },
          workingDirectories: [],
        }),
      );
    },
    async resolveSource() {
      await act(async () => {
        source = { ...source, resolved: true };
        applySnapshot(fixture.models.sessionCatalog, {
          sessions: [source],
          resolvedHasMoreByProject: {},
        });
      });
    },
    async hydrateFork(path: string) {
      await act(async () => {
        applySnapshot(fixture.models.sessionCatalog, {
          sessions: [source, forkedSummary(path)],
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
function visibleSessionId() {
  return document.querySelector('[data-slot="session-pane"]')?.getAttribute("data-session-id");
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
  it("immediately previews the fork in the project root and reconciles only when the runtime is hydrated", async () => {
    const pendingOpen = deferred<void>();
    const open = vi.fn<Client["projectSessions"]["open"]>(() => pendingOpen.promise);
    const fork = vi.fn<Client["projectSessions"]["fork"]>(async () => ({ sessionId: "forked" }));
    const create = vi.fn<Client["managedWorktrees"]["create"]>();
    const forkLookup = deferredForkLookup("/project");
    using fixture = renderContinuation({
      projectSessions: { fork, open, lookup: forkLookup.lookup },
      managedWorktrees: { create },
    });
    const dialog = await openFork(fixture.user);
    await fixture.user.click(
      within(dialog).getByRole("button", { name: "Use the project root (no worktree)" }),
    );
    await fixture.user.click(within(dialog).getByRole("button", { name: "Fork conversation" }));
    expect(screen.getByText("Fork of Source conversation")).toBeDefined();
    expect(screen.getByRole("status", { name: "Preparing fork in progress" })).toBeDefined();
    const previewId = visibleSessionId();
    expect(previewId).not.toBe("source");
    expect(previewId).not.toBe("forked");
    const composer = screen.getByRole("combobox", { name: "Message" });
    await fixture.user.type(composer, "Continue from here");
    expect(screen.getByRole("button", { name: "Send" }).hasAttribute("disabled")).toBe(true);
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
    expect(visibleSessionId()).toBe(previewId);
    await forkLookup.resolve();
    // Catalog arrival alone does not discard the ready-looking preview.
    expect(forkLookup.lookup).toHaveBeenCalledWith(
      { sessionId: "forked" },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(open).toHaveBeenCalledWith(
      { sessionId: "forked", workingDirectory: "/project" },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    await act(async () => pendingOpen.resolve());
    expect(visibleSessionId()).toBe(previewId);
    await fixture.hydrateFork("/project");
    await waitFor(() => expect(visibleSessionId()).toBe("forked"));
    expect(screen.getAllByText("Forked conversation").length).toBeGreaterThan(1);
    expect(screen.queryByText("Fork of Source conversation")).toBeNull();
    expect((screen.getByRole("combobox", { name: "Message" }) as HTMLTextAreaElement).value).toBe(
      "Continue from here",
    );
    expect(screen.getByRole("button", { name: "Send" }).hasAttribute("disabled")).toBe(false);
    expect(fork).toHaveBeenCalledTimes(1);
  });

  it("navigates before worktree creation or source resolution and never renders the intermediate resolved source", async () => {
    const pendingCreate = deferred<WorktreeRecord>();
    const create = vi.fn<Client["managedWorktrees"]["create"]>(() => pendingCreate.promise);
    const pendingFork = deferred<{ sessionId: string }>();
    const fork = vi.fn<Client["projectSessions"]["fork"]>(() => pendingFork.promise);
    const open = vi.fn<Client["projectSessions"]["open"]>(async () => undefined);
    const forkLookup = deferredForkLookup("/created-worktree");
    using fixture = renderContinuation({
      managedWorktrees: { create },
      projectSessions: { fork, open, lookup: forkLookup.lookup },
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
    expect(screen.getByText("Fork of Source conversation")).toBeDefined();
    const previewId = visibleSessionId();
    expect(previewId).not.toBe("source");
    expect(fork).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    await act(async () => pendingCreate.resolve(worktree("/created-worktree")));
    expect(visibleSessionId()).toBe(previewId);
    await fixture.resolveSource();
    expect(visibleSessionId()).toBe(previewId);
    expect(screen.getByText("Fork of Source conversation")).toBeDefined();
    expect(screen.queryByText("Conversation resolved")).toBeNull();
    await act(async () => pendingFork.resolve({ sessionId: "forked" }));
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
    await forkLookup.resolve();
    expect(open).toHaveBeenCalledWith(
      { sessionId: "forked", workingDirectory: "/created-worktree" },
      expect.anything(),
    );
    await fixture.hydrateFork("/created-worktree");
    await waitFor(() => expect(visibleSessionId()).toBe("forked"));
    expect(screen.queryByRole("status", { name: "Preparing fork in progress" })).toBeNull();
  });

  it("retains the immediate preview and draft after worktree failure, then retries successfully", async () => {
    const pendingCreate = deferred<WorktreeRecord>();
    const create = vi
      .fn<Client["managedWorktrees"]["create"]>()
      .mockImplementationOnce(() => pendingCreate.promise)
      .mockResolvedValue(worktree("/created-worktree"));
    const fork = vi.fn<Client["projectSessions"]["fork"]>(async () => ({ sessionId: "forked" }));
    using fixture = renderContinuation({
      managedWorktrees: { create },
      projectSessions: {
        fork,
        open: async () => undefined,
        lookup: async () => forkedSummary("/created-worktree"),
      },
    });
    const dialog = await openFork(fixture.user);
    await fixture.user.click(within(dialog).getByRole("button", { name: "Create a new worktree" }));
    await fixture.user.click(within(dialog).getByRole("button", { name: "Fork conversation" }));
    const previewId = visibleSessionId();
    await fixture.user.type(screen.getByRole("combobox", { name: "Message" }), "Keep this draft");
    await act(async () => pendingCreate.reject(new Error("Checkout failed")));
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      expect.stringContaining("Checkout failed"),
    );
    expect(visibleSessionId()).toBe(previewId);
    expect(fork).not.toHaveBeenCalled();
    await fixture.user.click(screen.getByRole("button", { name: "Retry fork setup" }));
    expect(create).toHaveBeenCalledTimes(2);
    expect(fork).toHaveBeenCalledTimes(1);
    expect(visibleSessionId()).toBe(previewId);
    await fixture.hydrateFork("/created-worktree");
    await waitFor(() => expect(visibleSessionId()).toBe("forked"));
    expect((screen.getByRole("combobox", { name: "Message" }) as HTMLTextAreaElement).value).toBe(
      "Keep this draft",
    );
  });

  it("retries runtime opening without creating another worktree or fork", async () => {
    const create = vi.fn<Client["managedWorktrees"]["create"]>(async () =>
      worktree("/created-worktree"),
    );
    const fork = vi.fn<Client["projectSessions"]["fork"]>(async () => ({ sessionId: "forked" }));
    const open = vi
      .fn<Client["projectSessions"]["open"]>()
      .mockRejectedValueOnce(new Error("Runtime unavailable"))
      .mockResolvedValue(undefined);
    using fixture = renderContinuation({
      managedWorktrees: { create },
      projectSessions: { fork, open, lookup: async () => forkedSummary("/created-worktree") },
    });
    const dialog = await openFork(fixture.user);
    await fixture.user.click(within(dialog).getByRole("button", { name: "Create a new worktree" }));
    await fixture.user.click(within(dialog).getByRole("button", { name: "Fork conversation" }));
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      expect.stringContaining("Runtime unavailable"),
    );
    const previewId = visibleSessionId();
    await fixture.user.click(screen.getByRole("button", { name: "Retry fork setup" }));
    expect(open).toHaveBeenCalledTimes(2);
    expect(create).toHaveBeenCalledTimes(1);
    expect(fork).toHaveBeenCalledTimes(1);
    expect(visibleSessionId()).toBe(previewId);
    await fixture.hydrateFork("/created-worktree");
    await waitFor(() => expect(visibleSessionId()).toBe("forked"));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps a created checkout on fork failure and honestly retries the fork request", async () => {
    const create = vi.fn<Client["managedWorktrees"]["create"]>(async () =>
      worktree("/created-worktree"),
    );
    const fork = vi
      .fn<Client["projectSessions"]["fork"]>()
      .mockRejectedValueOnce(new Error("Fork failed"))
      .mockResolvedValue({ sessionId: "forked" });
    using fixture = renderContinuation({
      managedWorktrees: { create },
      projectSessions: {
        fork,
        open: async () => undefined,
        lookup: async () => forkedSummary("/created-worktree"),
      },
    });
    const dialog = await openFork(fixture.user);
    await fixture.user.click(within(dialog).getByRole("button", { name: "Create a new worktree" }));
    await fixture.user.click(within(dialog).getByRole("button", { name: "Fork conversation" }));
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      expect.stringContaining("Backend changes may already exist"),
    );
    await fixture.user.click(screen.getByRole("button", { name: "Retry fork setup" }));
    expect(create).toHaveBeenCalledTimes(1);
    expect(fork).toHaveBeenCalledTimes(2);
    await fixture.hydrateFork("/created-worktree");
    await waitFor(() => expect(visibleSessionId()).toBe("forked"));
  });

  it("does not steal focus if the user returns to the source during background setup", async () => {
    const pendingFork = deferred<{ sessionId: string }>();
    const fork = vi.fn<Client["projectSessions"]["fork"]>(() => pendingFork.promise);
    using fixture = renderContinuation({
      projectSessions: {
        fork,
        open: async () => undefined,
        lookup: async () => forkedSummary("/current-worktree"),
      },
    });
    const dialog = await openFork(fixture.user);
    await fixture.user.click(within(dialog).getByRole("button", { name: "Fork conversation" }));
    expect(visibleSessionId()).not.toBe("source");
    await fixture.user.click(screen.getByRole("button", { name: "Back to source" }));
    expect(visibleSessionId()).toBe("source");
    await act(async () => pendingFork.resolve({ sessionId: "forked" }));
    await fixture.hydrateFork("/current-worktree");
    expect(visibleSessionId()).toBe("source");
    expect(screen.getAllByText("Source conversation").length).toBeGreaterThan(1);
    expect(fork).toHaveBeenCalledTimes(1);
  });

  it("keeps interrupted setup honest and ignores late startup completion until the preview is discarded", async () => {
    const pendingOpen = deferred<void>();
    const open = vi.fn<Client["projectSessions"]["open"]>(() => pendingOpen.promise);
    const fork = vi.fn<Client["projectSessions"]["fork"]>(async () => ({ sessionId: "forked" }));
    using fixture = renderContinuation({
      projectSessions: { fork, open, lookup: async () => forkedSummary("/current-worktree") },
    });
    const dialog = await openFork(fixture.user);
    await fixture.user.click(within(dialog).getByRole("button", { name: "Fork conversation" }));
    const previewId = visibleSessionId();
    expect(open).toHaveBeenCalledTimes(1);
    await fixture.interruptAgent();
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      expect.stringContaining("interrupted"),
    );
    await fixture.hydrateFork("/current-worktree");
    await act(async () => pendingOpen.resolve());
    expect(visibleSessionId()).toBe(previewId);
    expect(screen.getByRole("button", { name: "Retry fork setup" })).toBeDefined();
    await fixture.user.click(screen.getByRole("button", { name: "Discard preview" }));
    expect(visibleSessionId()).toBe("source");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(fork).toHaveBeenCalledTimes(1);
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
    const prompt = vi.fn<Client["sessionChats"]["prompt"]>(async () =>
      TurnId.make("10000000-0000-4000-8000-000000000003"),
    );
    using fixture = renderContinuation({
      projectSessions: { toolCompact, fork },
      sessionChats: { prompt },
    });
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
        },
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      ),
    );
    await waitFor(() => expect(prompt).toHaveBeenCalledOnce());
    expect(prompt).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Continue cleanly", attachments: [] }),
      expect.any(Object),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(fork).not.toHaveBeenCalled();
    expect(screen.getAllByText("Source conversation").length).toBeGreaterThan(1);
  });
});
