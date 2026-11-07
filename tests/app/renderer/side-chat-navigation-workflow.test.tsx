/** @vitest-environment jsdom */
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { applySnapshot } from "r-state-tree";
import { CAKE_CHAT_SESSION_ID } from "../../../src/contracts/cake-chats/cake-chat-identity";
import type { ConversationSnapshot } from "../../../src/contracts/conversations/conversation-data";
import { ReviewThread } from "../../../src/renderer/models/ReviewThread";
import { applyConversationSnapshot } from "../../../src/renderer/reducers/ConversationReducer";
import { renderAppShellNavigation } from "./app-shell-navigation-fixture";

beforeEach(() => {
  const measure = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      const rect = measure.call(this);
      // Below the ordinary accessory replacement breakpoint, but still a conversation split.
      return this.getAttribute("data-slot") === "side-chat-layout" ? { ...rect, width: 700 } : rect;
    },
  );
  vi.stubGlobal("PointerEvent", MouseEvent);
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function snapshot(sessionId: string, text: string): ConversationSnapshot {
  return {
    sessionId,
    sessionFile: `/sessions/${sessionId}.jsonl`,
    parts: [
      { id: `${sessionId}-answer`, kind: "text", role: "assistant", text, status: "complete" },
    ],
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

it.each(["alpha", CAKE_CHAT_SESSION_ID, `project-chat:${"1".repeat(64)}`])(
  "opens a side chat of %s beside its actual origin through tree, history and session links",
  async (parentSessionId) => {
    using fixture = renderAppShellNavigation({}, { history: ["beta"], transcriptViewport: true });
    const timestamp = new Date(0).toISOString();
    await act(async () => {
      if (parentSessionId.startsWith("project-chat:")) {
        applySnapshot(fixture.models.cakeChatCatalog, {
          loaded: true,
          sessions: [
            {
              sessionId: parentSessionId,
              title: "Project Chat",
              projectPath: "/alpha",
              createdAt: timestamp,
              modifiedAt: timestamp,
              messageCount: 1,
              resolved: false,
              unread: false,
            },
          ],
        });
      }
      const parent =
        parentSessionId === "alpha"
          ? fixture.root.sessionRegistry.findSession(parentSessionId)!
          : fixture.root.cakeChatCollectionStore.registry.load(parentSessionId);
      applyConversationSnapshot(
        parent.model,
        snapshot(parentSessionId, "Origin conversation body"),
      );
      parent.conversationSessionStore.chatStore.transcriptInteraction.setTranscriptScrollPosition({
        kind: "top",
      });
      const thread = ReviewThread.create({
        parentSessionId,
        id: "side-thread",
        sidecarSessionId: "selected-sidecar",
        workingDirectory: "/alpha",
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      thread.anchor = {
        ...thread.anchor,
        view: "session",
        selectedText: "Selected side conversation",
      };
      const catalog = fixture.models.discussionCatalog(parentSessionId);
      catalog.metadataLoaded = true;
      catalog.threads.push(thread);
      catalog.metadata.push({
        id: thread.id,
        parentSessionId,
        sidecarSessionId: thread.sidecarSessionId,
        workingDirectory: "/alpha",
        title: "Selected side conversation",
        running: false,
        status: "open",
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      applyConversationSnapshot(
        fixture.models.discussionConversation("selected-sidecar", "/alpha", parentSessionId),
        snapshot("selected-sidecar", "Separate side conversation body"),
      );
      await fixture.root.navigationStore.openConversationTarget({
        kind: parentSessionId === "alpha" ? "project-session" : "cake-chat",
        sessionId: parentSessionId,
      });
    });
    act(() =>
      fixture.root.discussionNavigationStore
        .session("selected-sidecar")!
        .chatStore.transcriptInteraction.setTranscriptScrollPosition({ kind: "top" }),
    );
    await fixture.showSessions();
    await fixture.user.click(
      await screen.findByRole("button", { name: "Selected side conversation" }),
    );
    const assertSplit = async () => {
      const panel = await screen.findByRole("complementary", {
        name: "Selected side conversation",
      });
      expect(screen.getByRole("separator", { name: "Resize side chat" })).toBeTruthy();
      expect(await within(panel).findByText("Separate side conversation body")).toBeTruthy();
      expect(screen.getByText("Origin conversation body")).toBeTruthy();
      expect(within(panel).queryByText("Origin conversation body")).toBeNull();
      expect(within(panel).getByRole("combobox", { name: "Reply to side chat" })).toBeTruthy();
      return panel;
    };
    let panel = await assertSplit();
    const splitter = screen.getByRole("separator", { name: "Resize side chat" });
    const originalWidth = Number(splitter.getAttribute("aria-valuenow"));
    act(() => splitter.focus());
    await fixture.user.keyboard("{ArrowRight}");
    expect(Number(splitter.getAttribute("aria-valuenow"))).toBe(originalWidth - 16);
    const resizedWidth = splitter.getAttribute("aria-valuenow");
    await fixture.user.type(within(panel).getByRole("combobox"), "Only the side draft");
    expect(
      screen.getByRole("combobox", {
        name:
          parentSessionId === "alpha"
            ? "Message"
            : parentSessionId === CAKE_CHAT_SESSION_ID
              ? "Message Cake Chat"
              : "Message Project Chat",
      }),
    ).toHaveProperty("value", "");

    await fixture.selectSession("beta");
    // The artifact cover exposes shell history; workbench Back traverses pane-local history first.
    if (!screen.queryByRole("button", { name: "Browse all artifacts" }))
      await fixture.user.click(
        within(screen.getByRole("navigation", { name: "Projects and global utilities" })).getByRole(
          "button",
          { name: /^(?:\d+ artifacts|Artifacts)$/ },
        ),
      );
    await fixture.user.click(await screen.findByRole("button", { name: "Browse all artifacts" }));
    await fixture.pressHistory("back");
    panel = await assertSplit();
    expect(within(panel).getByRole("combobox")).toHaveProperty("value", "Only the side draft");
    await fixture.user.click(
      within(panel).getByRole("button", { name: "Close Selected side conversation" }),
    );
    expect(await screen.findByText("Origin conversation body")).toBeTruthy();

    // Session links and app open-session requests share this navigation intent.
    await act(async () => {
      await fixture.root.navigationStore.openSessionLink(
        "selected-sidecar",
        "selected-sidecar-answer",
      );
    });
    panel = await assertSplit();
    expect(
      screen.getByRole("separator", { name: "Resize side chat" }).getAttribute("aria-valuenow"),
    ).toBe(resizedWidth);
    expect(within(panel).getByRole("combobox")).toHaveProperty("value", "Only the side draft");
    await waitFor(() =>
      expect(
        fixture.root.discussionNavigationStore.session("selected-sidecar")!.chatStore
          .transcriptInteraction.selectedMessageId,
      ).toBe("selected-sidecar-answer"),
    );
  },
);
