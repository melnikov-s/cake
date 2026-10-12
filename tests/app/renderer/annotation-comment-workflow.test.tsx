/** @vitest-environment jsdom */
import { act, cleanup, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TurnId } from "../../../src/contracts/conversations/conversation-data";
import type { Client } from "../../../src/renderer/client/Client";
import {
  commentSelection,
  preparedAnnotations,
  renderAnnotationComment,
} from "./annotation-comment-workflow-fixture";

const accepted: Awaited<ReturnType<Client["discussionSessions"]["start"]>> = {
  turnId: TurnId.make("10000000-0000-4000-8000-000000000001"),
  thread: {
    id: "annotation-thread",
    parentSessionId: "parent-1",
    sidecarSessionId: "annotation-sidecar",
    workingDirectory: "/project",
    anchor: {
      path: "session:parent-1/message/assistant-1",
      view: "message",
      start: { diffLine: 0 },
      end: { diffLine: 0 },
      selectedText: commentSelection.selectedText,
      contextBefore: commentSelection.contextBefore,
      contextAfter: commentSelection.contextAfter,
      startOffset: commentSelection.startOffset,
      endOffset: commentSelection.endOffset,
      messageId: commentSelection.messageId,
      entryId: commentSelection.entryId,
      diff: "",
    },
    parts: [],
    status: "open",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
};

afterEach(cleanup);

// Real prepared comment Chat -> Reviews -> typed service. These establish
// rendered draft/payload behavior, not native Markdown selection, annotation
// placement, popover geometry or focus. Selection handoff and message/artifact
// anchors with ordinary text are already covered by side-chat-workflow.test.tsx.
describe("Annotation-only selection comment workflow", () => {
  it("removes a note and sends only the remaining annotation, clearing it after acceptance", async () => {
    let accept!: (value: typeof accepted) => void;
    const admission = new Promise<typeof accepted>((resolve) => (accept = resolve));
    const start = vi.fn<Client["discussionSessions"]["start"]>(() => admission);
    using fixture = renderAnnotationComment(start);
    expect(screen.getByRole("combobox", { name: "Message about selected text" })).toHaveProperty(
      "value",
      "",
    );
    await fixture.user.click(screen.getByRole("button", { name: "View 2 annotations" }));
    expect(screen.getByText("Go deeper")).toBeDefined();
    expect(screen.getByText("Remove this note")).toBeDefined();
    await fixture.user.click(screen.getByRole("button", { name: "Remove annotation 2" }));
    expect(screen.queryByText("Remove this note")).toBeNull();
    await fixture.user.click(screen.getByRole("button", { name: "View 1 annotation" }));
    expect(screen.getByRole("button", { name: "Send" })).toHaveProperty("disabled", false);
    await fixture.user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect(start).toHaveBeenCalledExactlyOnceWith(
        {
          parentSessionId: "parent-1",
          workingDirectory: "/project",
          anchor: accepted.thread.anchor,
          text: "",
          annotations: [
            expect.objectContaining({ ...preparedAnnotations[0], id: expect.any(String) }),
          ],
        },
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      ),
    );
    expect(screen.getByRole("button", { name: "View 1 annotation" })).toBeDefined();
    await act(async () => {
      accept(accepted);
      await admission;
    });
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /^View \d+ annotations?$/ })).toBeNull(),
    );
  });

  it("preserves annotations after a failed creation and clears them on retry", async () => {
    const start = vi
      .fn<Client["discussionSessions"]["start"]>()
      .mockRejectedValueOnce(new Error("Discussion service unavailable"))
      .mockResolvedValueOnce(accepted);
    using fixture = renderAnnotationComment(start);
    await fixture.user.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText("Discussion service unavailable")).toBeDefined();
    await fixture.user.click(screen.getByRole("button", { name: "View 2 annotations" }));
    expect(screen.getByText("Go deeper")).toBeDefined();
    expect(screen.getByText("Remove this note")).toBeDefined();
    await fixture.user.click(screen.getByRole("button", { name: "View 2 annotations" }));
    await fixture.user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(start).toHaveBeenCalledTimes(2));
    expect(start.mock.calls[1]?.[0]).toEqual(start.mock.calls[0]?.[0]);
    expect(start.mock.calls[1]?.[0].annotations).toEqual(
      preparedAnnotations.map((annotation) => expect.objectContaining(annotation)),
    );
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "View 2 annotations" })).toBeNull(),
    );
    expect(screen.queryByText("Discussion service unavailable")).toBeNull();
  });

  it("disables an empty comment after its last annotation is removed", async () => {
    const start = vi.fn<Client["discussionSessions"]["start"]>();
    using fixture = renderAnnotationComment(start);
    await fixture.user.click(screen.getByRole("button", { name: "View 2 annotations" }));
    await fixture.user.click(screen.getByRole("button", { name: "Remove annotation 2" }));
    await fixture.user.click(screen.getByRole("button", { name: "Remove annotation 1" }));
    expect(screen.queryByRole("button", { name: /^View \d+ annotations?$/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Send" })).toHaveProperty("disabled", true);
    await fixture.user.click(screen.getByRole("button", { name: "Send" }));
    expect(start).not.toHaveBeenCalled();
  });
});
