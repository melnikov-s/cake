/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { applySnapshot, toSnapshot } from "r-state-tree";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  CAKE_CHAT_SESSION_ID,
  SESSION_ASSISTANT_ID,
} from "../../../src/contracts/cake-chats/cake-chat-identity";
import { TurnId } from "../../../src/contracts/conversations/conversation-data";
import type { Client } from "../../../src/renderer/client/Client";
import {
  cakeNativeHotkeyInputEventName,
  hotkeyDefinitions,
} from "../../../src/renderer/lib/hotkeys";
import { isMacPlatform } from "../../../src/renderer/lib/platform";
import { applyConversationUpdate } from "../../../src/renderer/reducers/ConversationReducer";
import { renderAppShellNavigation } from "./app-shell-navigation-fixture";
import { automationRun } from "./fixtures/automation-fixtures";

beforeEach(() => {
  vi.stubGlobal("PointerEvent", MouseEvent);
  Object.defineProperty(SVGElement.prototype, "getBBox", {
    configurable: true,
    value: () => ({ x: 0, y: 0, width: 24, height: 24 }),
  });
  vi.stubGlobal("matchMedia", (query: string) => ({
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

const projectChatId = `project-chat:${"a".repeat(64)}`;
const upInput = {
  key: "H",
  code: "KeyH",
  metaKey: isMacPlatform,
  ctrlKey: !isMacPlatform,
  altKey: false,
  shiftKey: true,
  repeat: false,
  isComposing: false,
};

async function pressUp(native = false, consumed = true) {
  await act(async () => {
    if (native) {
      // Exercise the existing native-input dispatch route without launching a tool surface.
      const event = new CustomEvent(cakeNativeHotkeyInputEventName, {
        detail: upInput,
        cancelable: true,
      });
      window.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    } else {
      expect(fireEvent.keyDown(window, upInput)).toBe(!consumed);
    }
  });
}

function addProjectChat(fixture: ReturnType<typeof renderAppShellNavigation>) {
  act(() =>
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
    }),
  );
  return fixture.root.cakeChatCollectionStore.registry.load(projectChatId);
}

it.each(["normal", "vscode", "browser"] as const)(
  "Mod+Shift+H climbs exactly one ancestor from %s, keeping visible identity, drafts and composer destination aligned",
  async (mode) => {
    const prompt = vi.fn<Client["sessionChats"]["prompt"]>(async () =>
      TurnId.make("10000000-0000-4000-8000-000000000001"),
    );
    using fixture = renderAppShellNavigation(
      { sessionChats: { prompt } },
      { history: ["gamma"], transcriptViewport: true },
    );
    expect(hotkeyDefinitions.find((entry) => entry.id === "return-to-project-chat")).toMatchObject({
      label: "Go up one level",
      defaultBinding: "Mod+Shift+H",
    });
    const local = addProjectChat(fixture);
    const global = fixture.root.cakeChatCollectionStore.registry.find(CAKE_CHAT_SESSION_ID)!;
    act(() => {
      applySnapshot(fixture.models.sessionCatalog, {
        sessions: toSnapshot(fixture.models.sessionCatalog).sessions!.map((session) => ({
          ...session,
          projectPath: "/alpha",
          projectName: "alpha",
          familyId: "alpha",
          familyParentSessionId: session.sessionId === "gamma" ? "beta" : "alpha",
          familyDepth: session.sessionId === "gamma" ? 2 : session.sessionId === "beta" ? 1 : 0,
        })),
        resolvedHasMoreByProject: {},
      });
      for (const id of ["alpha", "beta", "gamma"]) {
        const session = fixture.root.sessionRegistry.findSession(id)!;
        session.conversationSessionStore.composerStore.draftStore.setText(`${id} draft`);
        session.conversationSessionStore.chatStore.transcriptInteraction.setTranscriptScrollPosition(
          { kind: "top" },
        );
        applyConversationUpdate(session.model, {
          _tag: "Event",
          revision: 2,
          event: {
            _tag: "PartUpdated",
            sessionId: id,
            part: {
              id: `${id}-body`,
              kind: "text",
              role: "assistant",
              text: `${id} history`,
              status: "complete",
            },
          },
        });
        session.showPresentation(mode);
      }
      local.conversationSessionStore.composerStore.draftStore.setText("Project draft");
      global.conversationSessionStore.composerStore.draftStore.setText("Global draft");
      // jsdom cannot settle native bottom alignment; keep these history fixtures at top.
      for (const session of [local, global])
        session.conversationSessionStore.chatStore.transcriptInteraction.setTranscriptScrollPosition(
          { kind: "top" },
        );
    });
    for (const [id, body] of [
      [projectChatId, "Project history"],
      [CAKE_CHAT_SESSION_ID, "Global history"],
    ] as const) {
      await fixture.publishCakeChatProjection(
        id,
        [{ id: `${id}-body`, kind: "text", role: "assistant", text: body, status: "complete" }],
        "Snapshot",
      );
    }
    const sessions = ["gamma", "beta", "alpha"].map((id) =>
      fixture.root.sessionRegistry.findSession(id)!,
    );
    const retainedParts = sessions.map((session) => [
      ...session.conversationSessionStore.chatStore.parts,
    ]);
    for (const [id, body, composerName, draft] of [
      ["beta", "beta history", "Message", "beta draft"],
      ["alpha", "alpha history", "Message", "alpha draft"],
      [projectChatId, "Project history", "Message Project Chat", "Project draft"],
      [CAKE_CHAT_SESSION_ID, "Global history", "Message Cake Chat", "Global draft"],
    ] as const) {
      await pressUp(mode !== "normal");
      await waitFor(() =>
        expect(fixture.root.appShellStore.activeConversation?.sessionId).toBe(id),
      );
      expect(fixture.root.workspaceSession?.sessionId).toBe(id);
      expect(fixture.root.workspaceSession?.presentationMode).toBe("normal");
      expect(
        document.querySelector('[data-slot="session-pane"]')?.getAttribute("data-session-id"),
      ).toBe(id);
      expect(await screen.findByText(body)).toBeDefined();
      const breadcrumb = within(
        screen.getByRole("navigation", { name: "Conversation breadcrumb" }),
      );
      expect(
        breadcrumb
          .getAllByRole("button")
          .find((button) => button.getAttribute("aria-current") === "page")?.textContent,
      ).toContain(id === projectChatId ? "alpha" : id === CAKE_CHAT_SESSION_ID ? "Cake Chat" : id);
      expect(screen.getByRole("combobox", { name: composerName })).toHaveProperty("value", draft);
      expect(prompt).not.toHaveBeenCalled();
    }
    expect(fixture.root.workspaceProjectPath).toBeUndefined();
    const before = toSnapshot(fixture.root.appShellStore);
    await pressUp(mode !== "normal");
    expect(toSnapshot(fixture.root.appShellStore)).toEqual(before);
    expect(screen.getByRole("combobox", { name: "Message Cake Chat" })).toHaveProperty(
      "value",
      "Global draft",
    );
    for (const [index, session] of sessions.entries()) {
      expect(session.conversationSessionStore.composerStore.draftStore.text).toBe(
        `${session.sessionId} draft`,
      );
      expect(session.conversationSessionStore.chatStore.parts).toEqual(retainedParts[index]);
      expect(
        session.conversationSessionStore.chatStore.transcriptInteraction.transcriptScrollPosition,
      ).toEqual({ kind: "top" });
    }
    expect(local.conversationSessionStore.composerStore.draftStore.text).toBe("Project draft");
    await fixture.user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(prompt).toHaveBeenCalledOnce());
    expect(prompt).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: CAKE_CHAT_SESSION_ID, text: "Global draft" }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  },
);

it("does not skip a missing immediate parent or leak the retained project's context", async () => {
  using fixture = renderAppShellNavigation({}, { history: ["gamma"] });
  addProjectChat(fixture);
  act(() => {
    fixture.models.sessionCatalog.find("gamma")!.familyParentSessionId = "unavailable-parent";
  });
  await pressUp();
  expect(fixture.root.appShellStore.activeConversation?.sessionId).toBe("gamma");
  expect(screen.getByRole("combobox", { name: "Message" })).toBeDefined();
});

it.each(["Project", "Global"] as const)(
  "uses an automation's actual %s ownership context, not the retained project",
  async (kind) => {
    using fixture = renderAppShellNavigation({}, { history: ["gamma"] });
    addProjectChat(fixture);
    await fixture.publishCakeChatProjection(projectChatId);
    act(() =>
      fixture.root.navigationStore.openAutomationRun(
        automationRun({
          context:
            kind === "Project" ? { _tag: "Project", projectPath: "/alpha" } : { _tag: "Global" },
        }),
      ),
    );
    await pressUp();
    await waitFor(() =>
      expect(fixture.root.appShellStore.activeConversation?.sessionId).toBe(
        kind === "Project" ? projectChatId : CAKE_CHAT_SESSION_ID,
      ),
    );
    expect(fixture.root.workspaceProjectPath).toBe(kind === "Project" ? "/alpha" : undefined);
  },
);

it("does not invent a parent for the app-wide companion", async () => {
  using fixture = renderAppShellNavigation();
  act(() => {
    fixture.root.cakeChatCollectionStore.registry.load(SESSION_ASSISTANT_ID);
    fixture.root.navigationStore.selectCakeChat(SESSION_ASSISTANT_ID);
  });
  await pressUp();
  expect(fixture.root.appShellStore.activeConversation?.sessionId).toBe(SESSION_ASSISTANT_ID);
});

it("retains customized bindings under the existing action identity", async () => {
  using fixture = renderAppShellNavigation({}, { history: ["alpha"] });
  addProjectChat(fixture);
  await fixture.publishCakeChatProjection(projectChatId);
  act(() => fixture.root.settingsStore.hotkeys.assign("return-to-project-chat", "Mod+Shift+U"));
  await act(async () => fireEvent.keyDown(window, { ...upInput, key: "U", code: "KeyU" }));
  await waitFor(() =>
    expect(fixture.root.appShellStore.activeConversation?.sessionId).toBe(projectChatId),
  );
  await pressUp(false, false);
  expect(fixture.root.appShellStore.activeConversation?.sessionId).toBe(projectChatId);
});
