/** @vitest-environment jsdom */
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { VirtuosoMockContext } from "react-virtuoso";
import { afterEach, describe, expect, it } from "vitest";
import type { ConversationSnapshot } from "../../../src/contracts/conversations/conversation-data";
import type { UiPart } from "../../../src/contracts/conversations/session-contract";
import { Chat } from "../../../src/renderer/components/chat";
import { applyConversationUpdate } from "../../../src/renderer/reducers/ConversationReducer";
import { projectRecord, sessionSummary } from "./fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "./renderer-store-fixture";

afterEach(cleanup);

const text = (id: string, role: "user" | "assistant"): UiPart => ({
  id,
  kind: "text",
  role,
  text: `${role} ${id}`,
  status: "complete",
});

const conversation: UiPart[] = [
  text("user-1", "user"),
  text("assistant-1", "assistant"),
  text("user-2", "user"),
  { id: "tool-1", kind: "tool", name: "read", input: "README.md", state: "success" },
  text("assistant-2", "assistant"),
  text("user-3", "user"),
];

/** Two real Project Session Chats side by side, like a split workbench. */
function renderSplitPanes() {
  const ids = ["left-session", "right-session"] as const;
  const fixture = createRendererStoreFixture({
    projects: [projectRecord({ path: "/project", name: "Project" })],
    sessions: ids.map((sessionId) => sessionSummary({ sessionId, projectPath: "/project" })),
  });
  const chats = ids.map((sessionId) => {
    const session = fixture.root.sessionRegistry.load(sessionId, "/project");
    const snapshot: ConversationSnapshot = {
      sessionId,
      sessionFile: `/project/${sessionId}.jsonl`,
      parts: conversation,
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
    applyConversationUpdate(session.model, { _tag: "Snapshot", revision: 1, snapshot });
    return session.conversationSessionStore.chatStore;
  });
  const view = render(
    <VirtuosoMockContext.Provider value={{ viewportHeight: 800, itemHeight: 100 }}>
      {chats.map((chat) => (
        <section key={chat.id} aria-label={chat.id}>
          <Chat store={chat} compact composerFocusEnabled={false} />
        </section>
      ))}
    </VirtuosoMockContext.Provider>,
  );
  const pane = (sessionId: (typeof ids)[number]) => {
    const element = within(screen.getByRole("region", { name: sessionId }));
    return {
      composer: element.getByRole("combobox", { name: "Message" }),
      selected: () =>
        screen
          .getByRole("region", { name: sessionId })
          .querySelector('[data-slot="transcript-item"][aria-current="true"] [data-part-id]')
          ?.getAttribute("data-part-id") ?? undefined,
      message: (id: string) =>
        screen.getByRole("region", { name: sessionId }).querySelector(`[data-part-id="${id}"]`)!,
    };
  };
  return {
    user: userEvent.setup(),
    left: pane("left-session"),
    right: pane("right-session"),
    leftChat: chats[0]!,
    [Symbol.dispose]() {
      view.unmount();
      fixture[Symbol.dispose]();
    },
  };
}

// jsdom proves the key routing and Store transitions, not native focus or smooth
// scrolling; tests/electron/message-selection.spec.ts owns those.
describe("Transcript message keyboard selection", () => {
  it("walks assistant messages from an empty composer and returns to writing", async () => {
    using fixture = renderSplitPanes();
    const { user, left } = fixture;
    await user.click(left.composer);

    await user.keyboard("{ArrowUp}");
    expect(left.selected()).toBe("assistant-2");
    await user.keyboard("{ArrowUp}");
    expect(left.selected()).toBe("assistant-1");
    // The oldest assistant message stays selected instead of reaching user messages.
    await user.keyboard("{ArrowUp}");
    expect(left.selected()).toBe("assistant-1");
    await user.keyboard("{ArrowDown}");
    expect(left.selected()).toBe("assistant-2");
    await user.keyboard("{ArrowDown}");
    expect(left.selected()).toBeUndefined();
    expect(document.activeElement).toBe(left.composer);
    // Down with nothing selected stays with the composer.
    await user.keyboard("{ArrowDown}");
    expect(left.selected()).toBeUndefined();
  });

  it("only the pane holding focus responds", async () => {
    using fixture = renderSplitPanes();
    const { user, left, right } = fixture;
    await user.click(right.composer);
    await user.keyboard("{ArrowUp}{ArrowUp}");
    expect(right.selected()).toBe("assistant-1");
    expect(left.selected()).toBeUndefined();
  });

  it("leaves arrows to a composer with text and clears selection when typing", async () => {
    using fixture = renderSplitPanes();
    const { user, left } = fixture;
    await user.click(left.composer);
    await user.keyboard("draft{ArrowUp}");
    expect(left.selected()).toBeUndefined();

    await user.clear(left.composer);
    await user.keyboard("{ArrowUp}");
    expect(left.selected()).toBe("assistant-2");
    await user.keyboard("x");
    expect(left.selected()).toBeUndefined();
    expect(left.composer).toHaveProperty("value", "x");
  });

  it("clears with Escape and with a click outside the selected message", async () => {
    using fixture = renderSplitPanes();
    const { user, left } = fixture;
    await user.click(left.composer);
    await user.keyboard("{ArrowUp}");
    await user.keyboard("{Escape}");
    expect(left.selected()).toBeUndefined();

    await user.keyboard("{ArrowUp}");
    await user.click(left.message("assistant-2"));
    expect(left.selected()).toBe("assistant-2");
    await user.click(left.message("user-2"));
    expect(left.selected()).toBeUndefined();
  });

  it("ignores modified arrows so pane and app shortcuts keep them", async () => {
    using fixture = renderSplitPanes();
    const { user, left } = fixture;
    await user.click(left.composer);
    await user.keyboard("{Meta>}{Alt>}{ArrowUp}{/Alt}{/Meta}{Shift>}{ArrowUp}{/Shift}");
    expect(left.selected()).toBeUndefined();
  });

  it("continues from a linked message and highlights it as the selection", async () => {
    using fixture = renderSplitPanes();
    const { user, left, leftChat } = fixture;
    act(() => leftChat.transcriptInteraction.navigateToMessage("user-2"));
    expect(left.selected()).toBe("user-2");
    await user.click(left.composer);
    // Clicking the composer is a click elsewhere; select from the newest again.
    expect(left.selected()).toBeUndefined();
    act(() => leftChat.transcriptInteraction.navigateToMessage("user-2"));
    left.composer.focus();
    await user.keyboard("{ArrowUp}");
    expect(left.selected()).toBe("assistant-1");
  });
});
