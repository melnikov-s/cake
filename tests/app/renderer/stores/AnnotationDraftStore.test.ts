/** @vitest-environment jsdom */
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { Chat } from "../../../../src/renderer/components/chat";
import { createComposerInputFixture } from "../composer-input-workflow-fixture";

const annotation = (index: number) => ({
  messageId: `message-${index}`,
  selectedText: `selection-${index}`,
  startOffset: 7,
  endOffset: 7 + `selection-${index}`.length,
  contextBefore: "before ",
  contextAfter: " after",
});

// Native selection-admission exception: opening Add annotation requires actual
// transcript selection/geometry (Electron). Keep its admission boundary in real
// composer composition, including its real error callback. Do not fake selection
// or invent UI wiring. annotation-comment-workflow owns annotation-only send,
// removal, clearing and failure/retry; composer-input-workflow owns one-shot
// captured annotation delivery through real Chat.
describe("Composer annotation selection-admission boundary", () => {
  it("accepts the 100th selection, reports the 101st, and admits another after UI removal", async () => {
    using fixture = createComposerInputFixture(
      {},
      [],
      Array.from({ length: 99 }, (_, index) => annotation(index)),
    );
    const chat = fixture.conversation.chatStore;
    const view = render(
      createElement(Chat, { store: chat, compact: true, composerFocusEnabled: false }),
    );
    const user = userEvent.setup();
    try {
      // This is the single native Add-annotation admission seam, not simulated
      // transcript selection. Everything downstream uses real composition/UI.
      act(() => chat.addAnnotation(annotation(99)));
      expect(screen.getByRole("button", { name: "View 100 annotations" })).toBeDefined();
      expect(screen.queryByText("A message can include at most 100 annotations")).toBeNull();
      act(() => chat.addAnnotation(annotation(100)));
      expect(screen.getByText("A message can include at most 100 annotations")).toBeDefined();
      expect(screen.getByRole("button", { name: "View 100 annotations" })).toBeDefined();

      await user.click(screen.getByRole("button", { name: "View 100 annotations" }));
      expect(screen.getByText("selection-99", { exact: true })).toBeDefined();
      expect(screen.queryByText("selection-100", { exact: true })).toBeNull();
      await user.click(screen.getByRole("button", { name: "Remove annotation 1" }));
      expect(screen.getByRole("button", { name: "View 99 annotations" })).toBeDefined();
      await user.click(screen.getByRole("button", { name: "View 99 annotations" }));
      act(() => chat.addAnnotation(annotation(101)));
      expect(screen.getByRole("button", { name: "View 100 annotations" })).toBeDefined();
      await user.click(screen.getByRole("button", { name: "View 100 annotations" }));
      expect(screen.getByText("selection-101", { exact: true })).toBeDefined();
    } finally {
      view.unmount();
    }
  });
});
