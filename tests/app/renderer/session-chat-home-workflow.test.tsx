/** @vitest-environment jsdom */
import { act, cleanup, screen, waitFor } from "@testing-library/react";
import { applySnapshot, toSnapshot } from "r-state-tree";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CAKE_CHAT_SESSION_ID } from "../../../src/contracts/cake-chats/cake-chat-identity";
import { renderAppShellNavigation } from "./app-shell-navigation-fixture";
import { automationRun } from "./fixtures/automation-fixtures";
import { applySubagentUpdate } from "../../../src/renderer/reducers/SubagentReducer";
import { handleId, workerActivity } from "./subagent-activity-workflow-fixture";
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

it("hides the session affordance on application settings without changing navigation controls", async () => {
  using fixture = renderAppShellNavigation({}, { history: ["alpha"] });
  await addProjectChat(fixture);
  await fixture.user.click(screen.getByRole("button", { name: "Settings" }));
  expect(screen.queryByRole("button", { name: /^Back to Project Chat/ })).toBeNull();
  expect(screen.getByRole("button", { name: "Back to chat" })).toBeDefined();
});
