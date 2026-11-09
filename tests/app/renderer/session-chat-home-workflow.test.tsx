/** @vitest-environment jsdom */
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import { applySnapshot, toSnapshot } from "r-state-tree";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CAKE_CHAT_SESSION_ID } from "../../../src/contracts/cake-chats/cake-chat-identity";
import { renderAppShellNavigation } from "./app-shell-navigation-fixture";
import { automationRun } from "./fixtures/automation-fixtures";
import { applySubagentUpdate } from "../../../src/renderer/reducers/SubagentReducer";
import { handleId, workerActivity, workerTranscript } from "./subagent-activity-workflow-fixture";
import { isMacPlatform } from "../../../src/renderer/lib/platform";
import {
  editorLease,
  editorSessionId,
  renderEmbeddedEditor,
} from "./embedded-editor-workflow-fixture";

beforeEach(() => {
  vi.stubGlobal("PointerEvent", MouseEvent);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Object.defineProperty(SVGElement.prototype, "getBBox", {
    configurable: true,
    value: () => ({ x: 0, y: 0, width: 24, height: 24 }),
  });
});
afterEach(() => {
  cleanup();
  Reflect.deleteProperty(SVGElement.prototype, "getBBox");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const projectChatId = `project-chat:${"a".repeat(64)}`;

async function addProjectChat(fixture: ReturnType<typeof renderAppShellNavigation>) {
  act(() => {
    applySnapshot(fixture.models.cakeChatCatalog, {
      loaded: true,
      sessions: [
        ...toSnapshot(fixture.models.cakeChatCatalog).sessions!,
        {
          sessionId: projectChatId,
          projectPath: "/alpha",
          title: "Alpha Project Chat",
          createdAt: new Date(0).toISOString(),
          modifiedAt: new Date(0).toISOString(),
          messageCount: 0,
          resolved: false,
          unread: false,
        },
      ],
    });
    fixture.root.cakeChatCollectionStore.registry.load(projectChatId);
  });
  await fixture.publishCakeChatProjection(projectChatId);
}

it("returns directly to the owning Project Chat, not prior history, worktree or family parent", async () => {
  using fixture = renderAppShellNavigation({}, { history: ["beta", "gamma"] });
  await addProjectChat(fixture);
  act(() => {
    Object.assign(fixture.models.sessionCatalog.find("gamma")!, {
      projectPath: "/alpha",
      workingDirectory: "/managed-worktrees/gamma",
      familyId: "alpha",
      familyParentSessionId: "unavailable-parent",
      familyDepth: 2,
    });
    fixture.root.sessionRegistry
      .findSession("gamma")!
      .conversationSessionStore.composerStore.draftStore.setText("Keep session draft");
  });
  await fixture.user.click(screen.getByRole("button", { name: "Back to Project Chat for alpha" }));
  await waitFor(() =>
    expect(fixture.root.appShellStore.activeConversation?.sessionId).toBe(projectChatId),
  );
  expect(screen.getByRole("combobox", { name: "Message Project Chat" })).toBeDefined();
  expect(screen.queryByRole("button", { name: /^Back to / })).toBeNull();
  expect(
    fixture.root.sessionRegistry.findSession("gamma")!.conversationSessionStore.composerStore
      .draftStore.text,
  ).toBe("Keep session draft");
});

it("shows the button on a session entered without navigation history, and hides it in both permanent chats", async () => {
  using fixture = renderAppShellNavigation({}, { history: ["alpha"] });
  await addProjectChat(fixture);
  expect(screen.getByRole("button", { name: "Back to Project Chat for alpha" })).toBeDefined();
  await act(async () => {
    await fixture.root.navigationStore.openProjectChat("/alpha");
  });
  expect(screen.queryByRole("button", { name: /^Back to / })).toBeNull();
  await act(async () => {
    await fixture.root.navigationStore.openCakeChat(CAKE_CHAT_SESSION_ID);
  });
  expect(screen.queryByRole("button", { name: /^Back to / })).toBeNull();
  expect(screen.getByRole("combobox", { name: "Message Cake Chat" })).toBeDefined();
});

it.each(["alpha", projectChatId, CAKE_CHAT_SESSION_ID])(
  "returns a read-only fork/subagent directly to its actual source %s",
  async (parentSessionId) => {
    using fixture = renderAppShellNavigation({}, { history: ["beta"] });
    await addProjectChat(fixture);
    act(() =>
      applySubagentUpdate(fixture.models.subagentCatalog(parentSessionId), parentSessionId, {
        _tag: "Snapshot",
        revision: 1,
        parentSessionId,
        backgroundActive: false,
        activities: [
          workerActivity({
            parentSessionId,
            handleId,
            task: "Read-only context investigation",
            status: "complete",
            streaming: false,
            released: true,
          }),
        ],
      }),
    );
    await act(async () => fixture.root.navigationStore.openSubagentLink(parentSessionId, handleId));
    expect(screen.getByRole("region", { name: "Read-only context investigation" })).toBeDefined();
    expect(screen.queryByRole("combobox", { name: "Message subagent" })).toBeNull();
    await fixture.user.click(screen.getByRole("button", { name: "Back to source conversation" }));
    await waitFor(() =>
      expect(
        fixture.root.workspaceSession?.conversationSessionStore.sideChatStore.target,
      ).toBeUndefined(),
    );
    expect(fixture.root.appShellStore.activeConversation?.sessionId).toBe(parentSessionId);
    expect(screen.queryByRole("region", { name: "Read-only context investigation" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Back to source conversation" })).toBeNull();
    if (parentSessionId !== "alpha")
      expect(screen.queryByRole("navigation", { name: "Session home" })).toBeNull();
  },
);

it.each(["Project", "Global"] as const)(
  "uses the actual %s automation ownership rather than the retained project",
  async (kind) => {
    using fixture = renderAppShellNavigation({}, { history: ["gamma"] });
    await addProjectChat(fixture);
    act(() =>
      fixture.root.navigationStore.openAutomationRun(
        automationRun({
          context:
            kind === "Project" ? { _tag: "Project", projectPath: "/alpha" } : { _tag: "Global" },
        }),
      ),
    );
    await fixture.user.click(
      screen.getByRole("button", {
        name: kind === "Project" ? "Back to Project Chat for alpha" : "Back to Cake Chat",
      }),
    );
    await waitFor(() =>
      expect(fixture.root.appShellStore.activeConversation?.sessionId).toBe(
        kind === "Project" ? projectChatId : CAKE_CHAT_SESSION_ID,
      ),
    );
    expect(screen.queryByRole("button", { name: /^Back to / })).toBeNull();
  },
);

it.each([
  ["browser", false],
  ["vscode", false],
  ["browser", true],
  ["vscode", true],
] as const)(
  "removes the floating session home control in %s mode (subagent: %s) and restores it in Main",
  async (mode, subagent) => {
    const browserState = {
      sessionId: editorSessionId,
      url: "about:blank",
      title: "",
      loading: false,
      canGoBack: false,
      canGoForward: false,
      inspecting: false,
    };
    using fixture = renderEmbeddedEditor({
      vscode: { open: async () => editorLease("a") },
      browser: { open: async () => browserState, updateBounds: async () => browserState },
    });
    if (subagent) {
      act(() =>
        applySubagentUpdate(fixture.models.subagentCatalog(editorSessionId), editorSessionId, {
          _tag: "Snapshot",
          revision: 1,
          parentSessionId: editorSessionId,
          backgroundActive: false,
          activities: [
            workerActivity({
              parentSessionId: editorSessionId,
              handleId,
              status: "complete",
              streaming: false,
              released: true,
            }),
          ],
        }),
      );
      await act(async () =>
        fixture.root.navigationStore.openSubagentLink(editorSessionId, handleId),
      );
    }
    const homeButton = () =>
      screen.queryByRole("button", {
        name: subagent ? "Back to source conversation" : "Back to Project Chat for Project",
      });
    expect(homeButton()).not.toBeNull();
    await fixture.user.click(
      screen.getByRole("button", { name: mode === "browser" ? "Browser" : "VS Code" }),
    );
    if (mode === "browser") await screen.findByLabelText("Browser viewport");
    else await screen.findByTitle("VS Code workspace");
    expect(homeButton()).toBeNull();
    expect(screen.queryByRole("navigation", { name: "Session home" })).toBeNull();
    // Mode changes must not discard the selected session or its valid home target.
    expect(fixture.root.navigationStore.sessionChatHome).toEqual({
      projectPath: "/project",
      ...(subagent ? { sourceSessionId: editorSessionId } : {}),
    });
    await fixture.user.click(screen.getByRole("button", { name: "Main" }));
    expect(homeButton()).not.toBeNull();
  },
);

async function inspectionFixture(parentSessionId: string, released = false) {
  // Work-log Virtuoso also reads its custom scroll parent's geometry in jsdom.
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(900);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 900,
    bottom: 900,
    width: 900,
    height: 900,
    toJSON() {},
  });
  const fixture = renderAppShellNavigation({}, { history: ["beta"], transcriptViewport: true });
  await addProjectChat(fixture);
  await fixture.publishCakeChatProjection(parentSessionId, workerTranscript(), "Snapshot");
  await act(async () => {
    applySubagentUpdate(fixture.models.subagentCatalog(parentSessionId), parentSessionId, {
      _tag: "Snapshot",
      revision: 1,
      parentSessionId,
      backgroundActive: !released,
      activities: [
        workerActivity({
          parentSessionId,
          released,
          streaming: !released,
          status: released ? "complete" : "running",
        }),
      ],
    });
    await fixture.root.navigationStore.openCakeChat(parentSessionId);
    // jsdom cannot settle Virtuoso's native bottom alignment for either transcript.
    const owner = fixture.root.workspaceSession!;
    for (const chat of [
      owner.conversationSessionStore.chatStore,
      ...owner.subagentActivityStore.chatStores,
    ])
      chat.transcriptInteraction.setTranscriptScrollPosition({ kind: "top" });
  });
  return fixture;
}

async function inspectWorker(
  fixture: ReturnType<typeof renderAppShellNavigation>,
  entry: "activity" | "tool",
) {
  if (entry === "activity") {
    await fixture.user.click(screen.getByRole("button", { name: "Activity · 1 running" }));
    await fixture.user.click(
      screen.getByRole("button", { name: "Inspect subagent: Inspect the boundary" }),
    );
  } else {
    // Wait for the virtualized transcript before opening its work-log disclosure.
    if (!screen.queryByRole("button", { name: "Open subagent chat" })) {
      const summary = (await screen.findByText("Work log")).closest("summary");
      if (!summary) throw new Error("Missing work log disclosure");
      await fixture.user.click(summary);
    }
    await fixture.user.click(await screen.findByRole("button", { name: "Open subagent chat" }));
  }
  expect(screen.getByRole("region", { name: "Subagent" })).toBeDefined();
  expect(await screen.findByText("Inspecting now")).toBeDefined();
}

function expectParent(
  fixture: ReturnType<typeof renderAppShellNavigation>,
  parentSessionId: string,
) {
  expect(fixture.root.appShellStore.activeConversation?.sessionId).toBe(parentSessionId);
  expect(fixture.root.workspaceSession?.presentationMode).toBe("normal");
  expect(
    fixture.root.workspaceSession?.conversationSessionStore.sideChatStore.target,
  ).toBeUndefined();
  expect(screen.queryByRole("region", { name: "Subagent" })).toBeNull();
  expect(
    screen.getByRole("combobox", {
      name: parentSessionId === CAKE_CHAT_SESSION_ID ? "Message Cake Chat" : "Message Project Chat",
    }),
  ).toBeDefined();
}

it.each(
  [CAKE_CHAT_SESSION_ID, projectChatId].flatMap((parent) =>
    (["activity", "tool"] as const).map((entry) => ({ parent, entry })),
  ),
)(
  "$parent $entry inspection shows the worker breadcrumb and Back returns to its parent",
  async ({ parent, entry }) => {
    using fixture = await inspectionFixture(parent);
    await inspectWorker(fixture, entry);
    expect(
      fixture.root.workspaceSession?.conversationSessionStore.sideChatStore.target
        ?.navigationTarget,
    ).toEqual({ kind: "subagent", sessionId: parent, handleId });
    const breadcrumb = within(screen.getByRole("navigation", { name: "Conversation breadcrumb" }));
    expect(
      breadcrumb.getByRole("button", { name: "Inspect the boundary" }).getAttribute("aria-current"),
    ).toBe("page");
    await fixture.user.click(screen.getByRole("button", { name: "Back to source conversation" }));
    await waitFor(() => expectParent(fixture, parent));
  },
);

it.each(["breadcrumb", "rail", "menu"] as const)(
  "explicit global $0 selection clears a retained worker and restores Main without losing drafts",
  async (entry) => {
    using fixture = await inspectionFixture(CAKE_CHAT_SESSION_ID);
    const owner = fixture.root.workspaceSession!;
    const parentDraft = owner.conversationSessionStore.composerStore.draftStore;
    const workerChat = owner.subagentActivityStore.chatStore(handleId)!;
    act(() => {
      parentDraft.setText("Keep parent draft");
      workerChat.setDraft("Keep worker draft");
    });
    await inspectWorker(fixture, "activity");
    // Retain the inspection while visiting another workspace; home selection is explicit intent.
    await act(async () => fixture.root.navigationStore.openSession("beta"));
    expect(owner.conversationSessionStore.sideChatStore.target).toBeDefined();
    if (entry === "breadcrumb") {
      // Project breadcrumbs no longer include global chat. Reopen the retained global
      // inspection without an explicit home selection, then choose its real ancestor.
      await act(async () => fixture.root.navigationStore.openCakeChat(CAKE_CHAT_SESSION_ID));
      expect(screen.getByRole("region", { name: "Subagent" })).toBeDefined();
      await fixture.user.click(
        within(screen.getByRole("navigation", { name: "Conversation breadcrumb" })).getByRole(
          "button",
          { name: "Cake Chat" },
        ),
      );
    } else if (entry === "rail") {
      await fixture.user.click(screen.getByRole("button", { name: "Open Cake Chat" }));
    } else {
      await fixture.user.click(screen.getByRole("button", { name: "New session" }));
      await fixture.user.click(
        within(await screen.findByRole("dialog", { name: "New session" })).getByRole("option", {
          name: /Cake Chat/,
        }),
      );
    }
    await waitFor(() => expectParent(fixture, CAKE_CHAT_SESSION_ID));
    expect(screen.getByRole("combobox", { name: "Message Cake Chat" })).toHaveProperty(
      "value",
      "Keep parent draft",
    );
    expect(workerChat.draft).toBe("Keep worker draft");
  },
);

it.each(["breadcrumb", "rail"] as const)(
  "explicit Project Chat %s selection exits inspection",
  async (entry) => {
    using fixture = await inspectionFixture(projectChatId);
    await inspectWorker(fixture, "tool");
    if (entry === "breadcrumb")
      await fixture.user.click(
        within(screen.getByRole("navigation", { name: "Conversation breadcrumb" })).getByRole(
          "button",
          { name: "alpha" },
        ),
      );
    else
      await fixture.user.click(screen.getByRole("button", { name: "Open Project Chat for alpha" }));
    await waitFor(() => expectParent(fixture, projectChatId));
  },
);

it.each([CAKE_CHAT_SESSION_ID, projectChatId])(
  "released worker of %s remains navigable by its public identity and go-up",
  async (parent) => {
    using fixture = await inspectionFixture(parent, true);
    await inspectWorker(fixture, "tool");
    expect(fixture.root.conversationNavigatorStore.selectedKey).toBe(
      `subagent:${parent}:${handleId}`,
    );
    await fixture.user.keyboard(
      `{${isMacPlatform ? "Meta" : "Control"}>}{Shift>}h{/Shift}{/${isMacPlatform ? "Meta" : "Control"}}`,
    );
    await waitFor(() => expectParent(fixture, parent));
    await act(async () => fixture.root.navigationStore.openSubagentLink(parent, handleId));
    expect(screen.getByRole("region", { name: "Inspect the boundary" })).toBeDefined();
  },
);

it.each([CAKE_CHAT_SESSION_ID, projectChatId])(
  "generic workspace/history switching preserves %s inspection and both drafts",
  async (parent) => {
    using fixture = await inspectionFixture(parent);
    const owner = fixture.root.workspaceSession!;
    const parentDraft = owner.conversationSessionStore.composerStore.draftStore;
    const workerChat = owner.subagentActivityStore.chatStore(handleId)!;
    act(() => {
      parentDraft.setText("Parent retained");
      workerChat.setDraft("Worker retained");
    });
    await inspectWorker(fixture, "tool");
    const target = owner.conversationSessionStore.sideChatStore.target;
    await act(async () => fixture.root.navigationStore.openSession("beta"));
    await act(async () =>
      fixture.root.navigationStore.navigateToHistoryEntry({ kind: "cake-chat", sessionId: parent }),
    );
    expect(owner.conversationSessionStore.sideChatStore.target).toBe(target);
    expect(screen.getByRole("region", { name: "Subagent" })).toBeDefined();
    expect(parentDraft.text).toBe("Parent retained");
    expect(workerChat.draft).toBe("Worker retained");
  },
);

it.each(
  [CAKE_CHAT_SESSION_ID, projectChatId].flatMap((parent) =>
    (["link", "sessions"] as const).map((entry) => ({ parent, entry })),
  ),
)(
  "$parent explicit parent $entry still closes a legacy identityless worker",
  async ({ parent, entry }) => {
    using fixture = await inspectionFixture(parent);
    await inspectWorker(fixture, "activity");
    act(() => {
      const sideChat = fixture.root.workspaceSession!.conversationSessionStore.sideChatStore;
      sideChat.open({ ...sideChat.target!, navigationTarget: undefined });
    });
    if (entry === "link")
      await act(async () => fixture.root.navigationStore.openSessionLink(parent));
    else {
      await fixture.showSessions();
      const workspace = within(screen.getByRole("complementary", { name: "Workspace" }));
      await fixture.user.click(
        workspace.getByRole("button", {
          name: parent === CAKE_CHAT_SESSION_ID ? /^Cake Chat/ : /^alpha$/,
        }),
      );
    }
    await waitFor(() => expectParent(fixture, parent));
  },
);

it("hides the session affordance on application settings without changing navigation controls", async () => {
  using fixture = renderAppShellNavigation({}, { history: ["alpha"] });
  await addProjectChat(fixture);
  await fixture.user.click(screen.getByRole("button", { name: "Settings" }));
  expect(screen.queryByRole("button", { name: /^Back to Project Chat/ })).toBeNull();
  expect(screen.getByRole("button", { name: "Back to chat" })).toBeDefined();
});
