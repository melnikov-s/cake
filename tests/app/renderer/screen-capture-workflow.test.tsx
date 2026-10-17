/** @vitest-environment jsdom */
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { applySnapshot } from "r-state-tree";
import { StoreProvider } from "r-state-tree/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Schema } from "effect";
import {
  CaptureRouting,
  type CaptureResult,
} from "../../../src/contracts/desktop/screen-capture-data";
import type { ConversationSnapshot } from "../../../src/contracts/conversations/conversation-data";
import type { Client } from "../../../src/renderer/client/Client";
import { App } from "../../../src/renderer/components/app";
import { applyConversationUpdate } from "../../../src/renderer/reducers/ConversationReducer";
import { projectRecord, sessionSummary } from "./fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "./renderer-store-fixture";

function emptyConversation(sessionId: string): ConversationSnapshot {
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
function renderCapture(
  startScreenCapture: Client["electron"]["startScreenCapture"],
  staged = false,
) {
  const configureScreenCapture = vi.fn<Client["electron"]["configureScreenCapture"]>(
    async () => {},
  );
  const openSession = vi.fn<Client["projectSessions"]["open"]>(
    async ({ sessionId, workingDirectory }) => {
      applyConversationUpdate(fixture.models.projectConversation(sessionId, workingDirectory!), {
        _tag: "Snapshot",
        revision: 1,
        snapshot: emptyConversation(sessionId),
      });
    },
  );
  const fixture = createRendererStoreFixture({
    projects: [
      projectRecord({ path: "/project", name: "Project" }),
      projectRecord({ path: "/other", name: "Other Project" }),
    ],
    sessions: [
      ...(!staged
        ? [sessionSummary({ sessionId: "alpha", title: "Session A", projectPath: "/project" })]
        : []),
      sessionSummary({ sessionId: "beta", title: "Session B", projectPath: "/project" }),
      sessionSummary({
        sessionId: "gamma",
        title: "Session C",
        projectPath: "/other",
        workingDirectory: "/other",
      }),
    ],
    client: {
      electron: { startScreenCapture, configureScreenCapture },
      projectSessions: { open: openSession },
      workspaces: { loadStagedSlashCommands: async () => [] },
    },
  });
  const capture = fixture.root.screenCaptureStore;
  for (const id of ["alpha", "beta"]) {
    if (staged && id === "alpha") {
      fixture.root.sessionRegistry.pendingSessions.prepareStaged("/project", id);
      continue;
    }
    fixture.root.sessionRegistry.load(id, "/project");
    applyConversationUpdate(fixture.models.projectConversation(id, "/project"), {
      _tag: "Snapshot",
      revision: 1,
      snapshot: emptyConversation(id),
    });
  }
  const select = (id: string) => {
    fixture.root.navigationStore.selectProjectSession(id);
    fixture.root.projectWorkbenchStore.showLoadedSession(id);
    fixture.root.sessionLayoutStore.ensureSession(id);
  };
  select("alpha");
  fixture.root.sessionRegistry
    .findSession("alpha")!
    .conversationSessionStore.composerStore.draftStore.setText("Existing draft");
  fixture.root.appShellStore.showSettings();
  fixture.root.settingsStore.selectPage("screen-capture");
  const view = render(
    <StoreProvider store={fixture.root}>
      <App />
    </StoreProvider>,
  );
  return {
    root: fixture.root,
    models: fixture.models,
    capture,
    configureScreenCapture,
    openSession,
    select,
    user: userEvent.setup(),
    [Symbol.dispose]() {
      view.unmount();
      fixture[Symbol.dispose]();
    },
  };
}
function expectExistingDraft() {
  const input = screen.getByRole("combobox", { name: "Message" });
  if (!(input instanceof HTMLTextAreaElement)) throw new Error("Expected chat composer");
  expect(input.value).toBe("Existing draft");
}
beforeEach(() => {
  vi.stubGlobal("PointerEvent", MouseEvent);
  Object.defineProperty(SVGElement.prototype, "getBBox", {
    configurable: true,
    value: () => ({ x: 0, y: 0, width: 24, height: 24 }),
  });
  vi.stubGlobal("matchMedia", (query: string) => ({
    media: query,
    matches: true,
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

const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";
const captured: CaptureResult = {
  data: png,
  destination: { kind: "project-session", sessionId: "alpha" },
};
describe("Screen capture attachment workflow", () => {
  it("includes an unsent chat outside the Pi catalog and defaults to its existing draft", async () => {
    const start = vi.fn<Client["electron"]["startScreenCapture"]>(async (routing) => {
      Schema.decodeUnknownSync(CaptureRouting)(routing);
      return { data: png, destination: routing.defaultDestination };
    });
    using fixture = renderCapture(start, true);
    await fixture.user.click(screen.getByRole("button", { name: "Capture screenshot" }));
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultDestination: { kind: "project-session", sessionId: "alpha" },
      }),
      expect.anything(),
    );
    expect(() => Schema.decodeUnknownSync(CaptureRouting)(start.mock.calls[0]?.[0])).not.toThrow();
    expect(await screen.findByRole("button", { name: /^View Screenshot-/ })).toBeDefined();
    expectExistingDraft();
  });
  it.each(["projected", "pending"] as const)(
    "groups unsent destinations by their %s Managed Worktree Project without duplicating listed sessions",
    async (source) => {
      const start = vi.fn<Client["electron"]["startScreenCapture"]>(async () => undefined);
      using fixture = renderCapture(start);
      const worktree = {
        projectPath: "/project",
        worktreePath: "/worktree",
        branch: "agent/capture",
        baseBranch: "main",
        state: "active" as const,
        createdAt: "2026-01-01T00:00:00.000Z",
      };
      act(() => {
        if (source === "projected")
          applySnapshot(fixture.models.worktrees, { worktrees: [worktree] });
        else fixture.root.sessionCatalogStore.notePendingManagedWorktree(worktree);
        fixture.root.sessionRegistry.pendingSessions.prepareStaged("/worktree", "unsent");
        fixture.root.sessionRegistry.pendingSessions.prepareStaged("/other", "other-unsent");
        fixture.root.sessionRegistry.load("loaded-only", "/project");
      });
      await fixture.user.click(screen.getByRole("button", { name: "Capture screenshot" }));
      const routing = start.mock.calls[0]![0];
      expect(() => Schema.decodeUnknownSync(CaptureRouting)(routing)).not.toThrow();
      expect(
        routing.projects
          .find((project) => project.path === "/project")!
          .sessions.map((session) => session.sessionId),
      ).toEqual(["alpha", "beta", "unsent"]);
      expect(
        routing.projects
          .find((project) => project.path === "/other")!
          .sessions.map((session) => session.sessionId),
      ).toEqual(["gamma", "other-unsent"]);
      expect(routing.projects[0]!.sessions[2]).toEqual(
        expect.objectContaining({
          title: "New chat",
          draft: true,
          managedWorktree: expect.objectContaining({ branch: "agent/capture" }),
        }),
      );

      // Submission makes the same temporary identity a catalog/sidebar row.
      act(() =>
        fixture.root.sessionRegistry.pendingSessions.projectSubmission("unsent", "Capture plan"),
      );
      await fixture.user.click(screen.getByRole("button", { name: "Capture screenshot" }));
      const submitted = start.mock.calls[1]![0].projects.find(
        (project) => project.path === "/project",
      )!.sessions.filter((session) => session.sessionId === "unsent");
      expect(submitted).toHaveLength(1);
      expect(submitted[0]).toEqual(expect.objectContaining({ title: "Capture plan" }));
    },
  );

  it("uses sidebar Project order and session order with the same identity presentation facts", async () => {
    const start = vi.fn<Client["electron"]["startScreenCapture"]>(async () => undefined);
    using fixture = renderCapture(start);
    act(() => {
      fixture.root.projectCatalogStore.move("/other", "/project", "before");
      fixture.root.settingsStore.appearance.setSessionAvatarsEnabled(false);
      fixture.root.settingsStore.appearance.setSidebarCharactersEnabled(true);
      // A label sort and selected-row pin are owned by the sidebar, not reimplemented here.
      fixture.root.sidebarStore.sessionListStore.setProjectSessionSort("/project", "label");
    });
    await fixture.user.click(screen.getByRole("button", { name: "Capture screenshot" }));
    const routing = start.mock.calls[0]![0];
    expect(() => Schema.decodeUnknownSync(CaptureRouting)(routing)).not.toThrow();
    expect(routing.projects.map((project) => project.path)).toEqual(["/other", "/project"]);
    expect(routing.appearance).toEqual({
      theme: fixture.root.settingsStore.appearance.theme,
      sessionAvatarsEnabled: false,
      sidebarCharactersEnabled: true,
    });
    const projectRows = routing.projects[1]!.sessions;
    expect(projectRows.map((session) => session.sessionId)).toEqual(
      fixture.root.sidebarStore.sessionListStore
        .projectSessions("/project")
        .map((session) => session.sessionId),
    );
    expect(projectRows[0]).toEqual(
      expect.objectContaining({
        modifiedAt: fixture.root.sessionCatalogStore.find(projectRows[0]!.sessionId)!.modifiedAt,
        labels: fixture.root.sessionMetadataStore.sessionLabels(projectRows[0]!.sessionId),
        activityTime: fixture.root.sidebarStore.sessionActivityTime(projectRows[0]!.modifiedAt),
      }),
    );
  });

  it("includes collapsed family descendants before unsent pane destinations", async () => {
    const start = vi.fn<Client["electron"]["startScreenCapture"]>(async () => undefined);
    using fixture = renderCapture(start);
    act(() => {
      applySnapshot(fixture.models.sessionCatalog, {
        sessions: [
          sessionSummary({
            sessionId: "beta",
            title: "Parent",
            projectPath: "/project",
            familyChildSessionIds: ["alpha"],
            familyDepth: 0,
          }),
          sessionSummary({
            sessionId: "alpha",
            title: "Child",
            projectPath: "/project",
            familyParentSessionId: "beta",
            familyDepth: 1,
          }),
        ],
      });
      fixture.root.sidebarStore.sessionListStore.toggleFamilyCollapsed("beta");
      fixture.root.sessionRegistry.pendingSessions.prepareStaged("/project", "unsent");
    });
    await fixture.user.click(screen.getByRole("button", { name: "Capture screenshot" }));
    const routing = start.mock.calls[0]![0];
    expect(() => Schema.decodeUnknownSync(CaptureRouting)(routing)).not.toThrow();
    const sessions = routing.projects.find((project) => project.path === "/project")!.sessions;
    expect(sessions.map((session) => session.sessionId)).toEqual(["beta", "alpha", "unsent"]);
    expect(sessions[0]).toEqual(
      expect.objectContaining({ familyCollapsed: true, familyChildSessionIds: ["alpha"] }),
    );
    expect(sessions[1]).toEqual(
      expect.objectContaining({ familyParentSessionId: "beta", familyDepth: 1 }),
    );
    expect(sessions[2]).toEqual(expect.objectContaining({ title: "New chat", draft: true }));
  });

  it("offers catalog sessions, defaults to the last chat, and routes to a different chosen session", async () => {
    const start = vi.fn<Client["electron"]["startScreenCapture"]>(async () => ({
      data: png,
      destination: { kind: "project-session", sessionId: "beta" },
    }));
    using fixture = renderCapture(start);
    await fixture.user.click(screen.getByRole("button", { name: "Capture screenshot" }));
    await waitFor(() =>
      expect(start).toHaveBeenCalledWith(
        expect.objectContaining({
          defaultDestination: { kind: "project-session", sessionId: "alpha" },
          projects: expect.arrayContaining([
            expect.objectContaining({
              path: "/project",
              sessions: expect.arrayContaining([
                expect.objectContaining({ sessionId: "alpha", title: "Session A" }),
                expect.objectContaining({ sessionId: "beta", title: "Session B" }),
              ]),
            }),
          ]),
        }),
        expect.anything(),
      ),
    );
    expect(await screen.findByRole("button", { name: /^View Screenshot-/ })).toBeDefined();
    expect((screen.getByRole("combobox", { name: "Message" }) as HTMLTextAreaElement).value).toBe(
      "",
    );
    act(() => fixture.select("alpha"));
    expectExistingDraft();
    expect(screen.queryByRole("button", { name: /^View Screenshot-/ })).toBeNull();
  });

  it("opens an unloaded catalog session in another Project before attaching", async () => {
    using fixture = renderCapture(async () => ({
      data: png,
      destination: { kind: "project-session", sessionId: "gamma" },
    }));
    await fixture.user.click(screen.getByRole("button", { name: "Capture screenshot" }));
    expect(await screen.findByRole("button", { name: /^View Screenshot-/ })).toBeDefined();
    expect(fixture.openSession).toHaveBeenCalledWith(
      { sessionId: "gamma", workingDirectory: "/other" },
      expect.anything(),
    );
    expect(fixture.root.appShellStore.activeConversation?.sessionId).toBe("gamma");
    act(() => fixture.select("alpha"));
    expectExistingDraft();
  });

  it("creates a fresh session with the attachment in the chosen Project without sending", async () => {
    using fixture = renderCapture(async () => ({
      data: png,
      destination: { kind: "new-session", projectPath: "/other" },
    }));
    await fixture.user.click(screen.getByRole("button", { name: "Capture screenshot" }));
    expect(await screen.findByRole("button", { name: /^View Screenshot-/ })).toBeDefined();
    const active = fixture.root.appShellStore.activeConversation;
    expect(active?.kind).toBe("project-session");
    expect(active?.sessionId).not.toBe("alpha");
    expect(active?.sessionId).not.toBe("beta");
    expect(fixture.root.sessionRegistry.findSession(active!.sessionId)?.workspacePath).toBe(
      "/other",
    );
    expect((screen.getByRole("combobox", { name: "Message" }) as HTMLTextAreaElement).value).toBe(
      "",
    );
    act(() => fixture.select("alpha"));
    expectExistingDraft();
  });
  it("uses the last chat when no conversation is active and appends without replacing or sending the draft", async () => {
    const start = vi.fn<Client["electron"]["startScreenCapture"]>(async () => captured);
    using fixture = renderCapture(start);
    act(() => {
      fixture.root.navigationStore.showEmptyWorkbench();
      fixture.root.appShellStore.showSettings();
    });
    await fixture.user.click(screen.getByRole("button", { name: "Capture screenshot" }));
    await waitFor(() => expect(start).toHaveBeenCalledOnce());
    act(() => fixture.select("alpha"));
    expect(await screen.findByRole("button", { name: /^View Screenshot-/ })).toBeDefined();
    expectExistingDraft();
  });

  it("pins the destination at activation even if navigation changes before capture completes", async () => {
    let complete!: (value: CaptureResult) => void;
    const result = new Promise<CaptureResult>((resolve) => {
      complete = resolve;
    });
    using fixture = renderCapture(async () => result);
    await fixture.user.click(screen.getByRole("button", { name: "Capture screenshot" }));
    act(() => fixture.select("beta"));
    await act(async () => complete(captured));
    expect(await screen.findByRole("button", { name: /^View Screenshot-/ })).toBeDefined();
    expectExistingDraft();
  });

  it("leaves the existing draft untouched when the native experience is cancelled", async () => {
    using fixture = renderCapture(async () => undefined);
    await fixture.user.click(screen.getByRole("button", { name: "Capture screenshot" }));
    await fixture.user.click(screen.getByRole("button", { name: "Back to chat" }));
    expect(screen.queryByRole("button", { name: /^View Screenshot-/ })).toBeNull();
    expectExistingDraft();
  });

  it("reports native failures without destroying the draft and supports another capture", async () => {
    const start = vi
      .fn<Client["electron"]["startScreenCapture"]>()
      .mockRejectedValueOnce(new Error("Allow screen recording"))
      .mockResolvedValueOnce(captured);
    using fixture = renderCapture(start);
    await fixture.user.click(screen.getByRole("button", { name: "Capture screenshot" }));
    expect(await screen.findByText("Allow screen recording")).toBeDefined();
    await fixture.user.click(screen.getByRole("button", { name: "Capture screenshot" }));
    expect(await screen.findByRole("button", { name: /^View Screenshot-/ })).toBeDefined();
  });

  it("does not attach a finished capture to a chat resolved during capture", async () => {
    let complete!: (value: CaptureResult) => void;
    const result = new Promise<CaptureResult>((resolve) => {
      complete = resolve;
    });
    using fixture = renderCapture(async () => result);
    await fixture.user.click(screen.getByRole("button", { name: "Capture screenshot" }));
    act(() => {
      const summary = fixture.models.sessionCatalog.sessions.find(
        (session) => session.sessionId === "alpha",
      );
      if (!summary) throw new Error("Missing session");
      summary.resolved = true;
    });
    await act(async () => complete(captured));
    expect(await screen.findByText("The destination chat is no longer editable.")).toBeDefined();
  });

  it("configures the resized-image limit and disables the global shortcut through Settings", async () => {
    using fixture = renderCapture(async () => undefined);
    await fixture.user.selectOptions(screen.getByLabelText("Maximum image dimension"), "1024");
    await waitFor(() =>
      expect(fixture.configureScreenCapture).toHaveBeenLastCalledWith(
        { shortcut: "Mod+Shift+6", maxDimension: 1024 },
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      ),
    );
    await fixture.user.click(screen.getByRole("button", { name: "Clear" }));
    await waitFor(() =>
      expect(fixture.configureScreenCapture).toHaveBeenLastCalledWith(
        { shortcut: "", maxDimension: 1024 },
        expect.anything(),
      ),
    );
    expect(screen.getByRole("button", { name: "Screen capture shortcut" }).textContent).toContain(
      "Not assigned",
    );
  });
});
