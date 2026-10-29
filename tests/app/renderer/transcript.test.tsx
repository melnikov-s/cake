/** @vitest-environment jsdom */
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TurnId } from "../../../src/contracts/conversations/conversation-data";
import type { UiPart } from "../../../src/contracts/conversations/session-contract";
import type { DiscussionThread } from "../../../src/contracts/discussion-sessions/discussion-session-data";
import type { Client } from "../../../src/renderer/client/Client";
import { captureMessageSelection } from "../../../src/renderer/components/chat-transcript";
import { renderTranscriptFinish, transcriptFinishSessionId } from "./transcript-finish-fixture";

const question: Extract<UiPart, { kind: "text" }> = {
  id: "question",
  entryId: "question-entry",
  kind: "text",
  role: "user",
  text: "Original question",
  status: "complete",
};
const answer: Extract<UiPart, { kind: "text" }> = {
  id: "answer",
  entryId: "answer-entry",
  kind: "text",
  role: "assistant",
  text: "Alpha **important** detail.",
  status: "complete",
};

afterEach(() => {
  window.getSelection()?.removeAllRanges();
  cleanup();
});

// Scroll opening/following/restoration and offscreen reveal are native contracts:
// session-scroll-position, message-navigation and message-keyboard-selection
// Electron suites exercise real Virtuoso. message-selection and side-chat-streaming
// own native prose/code selection, highlights, annotation placement and focus.
// No virtualizer substitute, fake Range geometry or parent callback is used here.
// Rendering/formatting/loading/error/fullscreen/attachments are consolidated in
// transcript-rendering/interactions, chat-surface and work-log-presentation workflows.
describe("Transcript reader workflows", () => {
  it("opens real continuation controls from completed messages and restores the selected user's prompt after tree navigation", async () => {
    const navigate = vi.fn<Client["projectSessions"]["navigate"]>(async () => undefined);
    const fork = vi.fn<Client["projectSessions"]["fork"]>();
    using fixture = renderTranscriptFinish([question, answer], {
      client: { projectSessions: { navigate, fork } },
    });
    await fixture.user.click(
      screen.getByRole("button", { name: "Fork response with full context into new chat" }),
    );
    const continuation = await screen.findByRole("dialog", { name: "Fork this conversation" });
    expect(
      within(continuation)
        .getByRole("button", { name: "Use the current working directory" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    await fixture.user.click(within(continuation).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog", { name: "Fork this conversation" })).toBeNull();
    expect(fork).not.toHaveBeenCalled();

    await fixture.user.click(
      screen.getByRole("button", { name: "Continue from response in session tree" }),
    );
    let navigation = await screen.findByRole("dialog", { name: "Continue from this message" });
    await fixture.user.click(within(navigation).getByRole("button", { name: "Continue here" }));
    await waitFor(() => expect(navigate).toHaveBeenCalledOnce());
    expect(navigate).toHaveBeenLastCalledWith(
      { sessionId: transcriptFinishSessionId, entryId: "answer-entry", summarize: false },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    await fixture.user.click(
      screen.getByRole("button", { name: "Continue from message in session tree" }),
    );
    navigation = await screen.findByRole("dialog", { name: "Continue from this message" });
    await fixture.user.click(within(navigation).getByRole("button", { name: "Continue here" }));
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Message" })).toHaveProperty(
        "value",
        question.text,
      ),
    );
    expect(navigate).toHaveBeenLastCalledWith(
      { sessionId: transcriptFinishSessionId, entryId: "question-entry", summarize: false },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("pauses the working indicator while an extension waits for the user, then resumes after confirmation", async () => {
    const respond = vi.fn<Client["artifacts"]["respondToUi"]>(async () => undefined);
    using fixture = renderTranscriptFinish([question], {
      streaming: true,
      waitingForUser: true,
      client: { artifacts: { respondToUi: respond } },
    });
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Continue the task?")).toBeDefined();
    expect(fixture.container.querySelector('[data-slot="loading-state"]')).toBeNull();
    await fixture.user.click(within(dialog).getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(respond).toHaveBeenCalledExactlyOnceWith({
      operationId: "transcript-confirm",
      sessionId: transcriptFinishSessionId,
      uiRequestId: "transcript-confirm-request",
      value: "true",
      cancelled: false,
    });
    expect(fixture.container.querySelector('[data-slot="loading-state"]')).not.toBeNull();
    fixture.publish([question, answer]);
    expect(fixture.container.querySelector('[data-slot="loading-state"]')).toBeNull();
  });

  it("reopens a persisted message side chat from the menu and sends a reply to its authoritative sidecar", async () => {
    const prompt = vi.fn<Client["sessionChats"]["prompt"]>(async () =>
      TurnId.make("10000000-0000-4000-8000-000000000001"),
    );
    const thread: DiscussionThread = {
      id: "transcript-selection-thread",
      workingDirectory: "/project",
      parentSessionId: transcriptFinishSessionId,
      sidecarSessionId: "transcript-selection-sidecar",
      anchor: {
        path: `session:${transcriptFinishSessionId}/message/answer`,
        view: "message",
        messageId: answer.id,
        entryId: answer.entryId,
        selectedText: "important",
        // Valid unpositioned anchor: reopening from the menu needs no native
        // marker coordinates. Positioned markers remain an Electron contract.
        contextBefore: "Alpha ",
        contextAfter: " detail.",
        start: { diffLine: 0 },
        end: { diffLine: 0 },
        diff: "",
      },
      parts: [
        { ...question, id: "sidecar-question", text: "Why this word?" },
        { ...answer, id: "sidecar-answer", text: "Because it carries the point." },
      ],
      status: "open",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    using fixture = renderTranscriptFinish([question, answer], {
      thread,
      client: { sessionChats: { prompt } },
    });
    const reopen = async () => {
      await fixture.user.click(screen.getByRole("button", { name: "Side chats, 1 open" }));
      const menu = screen.getByRole("dialog", { name: "Open side chats" });
      await fixture.user.click(within(menu).getByRole("button", { name: /important/ }));
    };
    await reopen();
    const panel = screen.getByRole("complementary", { name: "Side chat" });
    expect(within(panel).getByText("Why this word?")).toBeDefined();
    expect(within(panel).getByText("Because it carries the point.")).toBeDefined();
    const input = within(panel).getByRole("combobox", { name: "Reply to selection side chat" });
    await fixture.user.type(input, "Explain the constraint");
    await fixture.user.click(within(panel).getByRole("button", { name: "Send" }));
    await waitFor(() => expect(prompt).toHaveBeenCalledOnce());
    expect(prompt).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: thread.sidecarSessionId,
        text: "Explain the constraint",
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    await fixture.user.click(within(panel).getByRole("button", { name: "Close Side chat" }));
    expect(screen.queryByRole("complementary", { name: "Side chat" })).toBeNull();
    await reopen();
    expect(
      within(screen.getByRole("complementary", { name: "Side chat" })).getByText(
        "Because it carries the point.",
      ),
    ).toBeDefined();
  });

  // Native-selection serialization boundary, not simulated drag or layout proof.
  // The Range is an incoming native selection over real rendered Markdown. Its
  // offsets/context must survive formatting without needing any fabricated rect.
  it("serializes an incoming Markdown text range into a stable persisted message anchor", async () => {
    using fixture = renderTranscriptFinish([answer]);
    const emphasized = await screen.findByText("important", { exact: true });
    const content = fixture.container.querySelector<HTMLElement>('[data-slot="message-content"]');
    const selected = emphasized.firstChild;
    if (!content || !selected) throw new Error("Missing rendered Markdown selection target");
    const range = document.createRange();
    range.setStart(selected, 0);
    range.setEnd(selected, "important".length);
    const selection = window.getSelection();
    if (!selection) throw new Error("Missing native selection adapter");
    selection.addRange(range);
    expect(captureMessageSelection(content, answer.id, answer.entryId)).toEqual({
      messageId: answer.id,
      entryId: answer.entryId,
      selectedText: "important",
      startOffset: 6,
      endOffset: 15,
      contextBefore: "Alpha ",
      contextAfter: " detail.",
    });
  });
});
