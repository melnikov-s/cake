/** @vitest-environment jsdom */
import { act, cleanup, screen, waitFor } from "@testing-library/react";
import { applySnapshot, toSnapshot } from "r-state-tree";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CAKE_CHAT_SESSION_ID } from "../../../src/contracts/cake-chats/cake-chat-identity";
import { renderAppShellNavigation } from "./app-shell-navigation-fixture";
import { automationRun } from "./fixtures/automation-fixtures";

beforeEach(() => {
  vi.stubGlobal("PointerEvent", MouseEvent);
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

it("hides the session affordance on application settings without changing navigation controls", async () => {
  using fixture = renderAppShellNavigation({}, { history: ["alpha"] });
  await addProjectChat(fixture);
  await fixture.user.click(screen.getByRole("button", { name: "Settings" }));
  expect(screen.queryByRole("button", { name: /^Back to Project Chat/ })).toBeNull();
  expect(screen.getByRole("button", { name: "Back to chat" })).toBeDefined();
});
