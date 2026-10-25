/** @vitest-environment jsdom */
import { TurnId } from "../../../src/contracts/conversations/conversation-data";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Client } from "../../../src/renderer/client/Client";
import { Chat } from "../../../src/renderer/components/chat";
import { applyConversationUpdate } from "../../../src/renderer/reducers/ConversationReducer";
import { projectRecord, sessionSummary } from "./fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "./renderer-store-fixture";
import type { TestClientOverrides } from "./test-client";
import { deliveryGate } from "./conversation-delivery-workflow-fixture";

const sessionId = "session-one";
const continuationTurnId = TurnId.make("10000000-0000-4000-8000-000000000003");
const source = {
  kind: "source" as const,
  name: "active.ts",
  location: { path: "src/active.ts", range: { start: { line: 1 }, end: { line: 2 } } },
};
const pastedText = (label: string) => `${label}\n${"attachment details\n".repeat(50)}`;
const textAttachment = (label: string) => ({
  kind: "text" as const,
  name: "Pasted text · 52 lines",
  text: pastedText(label),
});
async function pasteAttachment(user: ReturnType<typeof userEvent.setup>, label: string) {
  await user.click(input());
  await user.paste(pastedText(label));
}

async function renderComposer(
  client: TestClientOverrides = {},
  options: { editor?: boolean; streaming?: boolean } = {},
) {
  const fixture = createRendererStoreFixture({
    projects: [projectRecord({ path: "/project", name: "Project" })],
    sessions: [sessionSummary({ sessionId, projectPath: "/project" })],
    client: {
      ...client,
      vscode: {
        open: async () => undefined,
        updateBounds: async () => undefined,
        updateAnnotations: async () => undefined,
        ...client.vscode,
      },
    },
  });
  const session = fixture.root.sessionRegistry.load(sessionId, "/project");
  fixture.root.navigationStore.selectProjectSession(sessionId);
  fixture.root.projectWorkbenchStore.showLoadedSession(sessionId);
  const model = fixture.models.projectConversation(sessionId, "/project");
  applyConversationUpdate(model, {
    _tag: "Snapshot",
    revision: 1,
    snapshot: {
      sessionId,
      sessionFile: "/project/session.jsonl",
      parts: [
        {
          id: "assistant-1",
          entryId: "assistant-entry",
          kind: "text",
          role: "assistant",
          text: "Completed response",
          status: "complete",
        },
      ],
      models: [],
      thinkingLevel: "off",
      availableThinkingLevels: ["off"],
      streaming: options.streaming ?? false,
      diagnostics: [],
      commands: [],
      compatibility: { resources: [], diagnostics: [] },
      extensionUi: { statuses: [] },
      tree: [],
    },
  });
  const presentation = fixture.root.projectWorkbenchStore.presentationStore;
  const selection = (path = "src/active.ts") =>
    presentation.receive({
      type: "embedded-editor-selection",
      workspacePath: "/project",
      path,
      startLine: 1,
      endLine: 2,
    });
  if (options.editor) {
    await presentation.embeddedEditorStore.show();
    selection();
  }
  const view = render(
    <Chat
      store={session.conversationSessionStore.chatStore}
      embedded
      composerFocusEnabled={false}
    />,
  );
  return {
    user: userEvent.setup(),
    selectEditor(path: string) {
      act(() => selection(path));
    },
    annotateEditor(comment: string) {
      act(() =>
        presentation.receive({
          type: "embedded-editor-annotation-requested",
          workspacePath: "/project",
          path: "src/active.ts",
          startLine: 1,
          startColumn: 0,
          endLine: 2,
          endColumn: 5,
          selectedText: "return total;",
          contextBefore: "",
          contextAfter: "",
          comment,
        }),
      );
    },
    [Symbol.dispose]() {
      view.unmount();
      fixture[Symbol.dispose]();
    },
  };
}
async function typeAndSend(user: ReturnType<typeof userEvent.setup>, text: string) {
  await user.type(screen.getByRole("combobox", { name: "Message" }), text);
  await user.click(screen.getByRole("button", { name: "Send" }));
}
const input = () => screen.getByRole<HTMLTextAreaElement>("combobox", { name: "Message" });
afterEach(cleanup);

describe("Chat composer workflow", () => {
  it("turns a large paste into a compact attachment without putting it in the message and retains the original text", async () => {
    const prompt = vi.fn<Client["sessionChats"]["prompt"]>(async () => TurnId.make("pasted-input"));
    using composer = await renderComposer({ sessionChats: { prompt } });
    const log = "PRIVATE_PASTED_LOG\r\n" + "error details\n".repeat(50) + "  ";
    await composer.user.click(input());
    await composer.user.paste(log);
    expect(input().value).toBe("");
    expect(screen.getByRole("button", { name: /^Pasted text/ })).toBeTruthy();
    expect(screen.queryByText("PRIVATE_PASTED_LOG")).toBeNull();
    await typeAndSend(composer.user, "Research the attached log");
    await waitFor(() => expect(prompt).toHaveBeenCalled());
    expect(prompt.mock.calls[0]?.[0]).toMatchObject({
      text: "Research the attached log",
      attachments: [{ kind: "text", text: log }],
    });
  });
  it("leaves a short paste as ordinary message text", async () => {
    using composer = await renderComposer();
    await composer.user.click(input());
    await composer.user.paste("Please research this");
    expect(input().value).toBe("Please research this");
    expect(screen.queryByRole("button", { name: /^Pasted text/ })).toBeNull();
  });
  it("restores consumed editor context on failure, then sends it once on retry", async () => {
    const prompt = vi
      .fn<Client["sessionChats"]["prompt"]>()
      .mockRejectedValueOnce(new Error("Send failed"))
      .mockResolvedValue(TurnId.make("10000000-0000-4000-8000-000000000001"));
    using fixture = await renderComposer({ sessionChats: { prompt } }, { editor: true });
    await typeAndSend(fixture.user, "Explain this");
    expect(await screen.findByText("Send failed")).toBeDefined();
    expect(input().value).toBe("Explain this");
    expect(screen.getByRole("button", { name: /Remove.*active.ts/ })).toBeDefined();
    await fixture.user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(prompt).toHaveBeenCalledTimes(2));
    expect(prompt.mock.calls[1]?.[0].attachments).toEqual([
      expect.objectContaining({ kind: "source", location: source.location }),
    ]);
    expect(screen.queryByRole("button", { name: /Remove.*active.ts/ })).toBeNull();
    await typeAndSend(fixture.user, "Next request");
    expect(prompt).toHaveBeenLastCalledWith(
      expect.objectContaining({ text: "Next request", attachments: [] }),
      expect.any(Object),
    );
  });

  it("does not replace the next draft or editor context when an in-flight send fails", async () => {
    let reject!: (error: Error) => void;
    const pending = new Promise<TurnId>((_resolve, fail) => {
      reject = fail;
    });
    const prompt = vi
      .fn<Client["sessionChats"]["prompt"]>()
      .mockReturnValueOnce(pending)
      .mockResolvedValue(TurnId.make("10000000-0000-4000-8000-000000000002"));
    using fixture = await renderComposer({ sessionChats: { prompt } }, { editor: true });
    await pasteAttachment(fixture.user, "sent");
    await typeAndSend(fixture.user, "First message");
    await fixture.user.type(input(), "Next message");
    await pasteAttachment(fixture.user, "next");
    fixture.selectEditor("src/next.ts");
    await act(async () => {
      reject(new Error("Send failed"));
      await pending.catch(() => undefined);
    });
    expect(await screen.findByText("Send failed")).toBeDefined();
    expect(input().value).toBe("Next message");
    expect(screen.getAllByRole("button", { name: /^Remove Pasted text/ })).toHaveLength(2);
    expect(screen.getByRole("button", { name: /Remove.*next.ts/ })).toBeDefined();
    await fixture.user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(prompt).toHaveBeenCalledTimes(2));
    expect(prompt.mock.calls[1]?.[0]).toMatchObject({
      text: "Next message",
      attachments: expect.arrayContaining([
        textAttachment("next"),
        textAttachment("sent"),
        expect.objectContaining({
          kind: "source",
          location: expect.objectContaining({ path: "src/next.ts" }),
        }),
      ]),
    });
  });

  it("sends the continuation and all attachments together after tool compaction, consuming them once", async () => {
    const toolCompact = vi.fn<Client["projectSessions"]["toolCompact"]>(async () => ({
      sessionId,
    }));
    const prompt = vi.fn<Client["sessionChats"]["prompt"]>(async () => continuationTurnId);
    using fixture = await renderComposer(
      {
        projectSessions: { toolCompact },
        sessionChats: { prompt },
      },
      { editor: true },
    );
    await pasteAttachment(fixture.user, "reference");
    await typeAndSend(fixture.user, "/toolcompact Continue cleanly");
    await waitFor(() =>
      expect(toolCompact).toHaveBeenCalledWith(
        {
          sessionId,
          workingDirectory: "/project",
          entryId: "assistant-entry",
        },
        expect.any(Object),
      ),
    );
    await waitFor(() => expect(prompt).toHaveBeenCalledOnce());
    expect(prompt.mock.calls[0]?.[0]).toMatchObject({
      text: "Continue cleanly",
      attachments: [
        expect.objectContaining({ kind: "source", location: source.location }),
        textAttachment("reference"),
      ],
    });
    expect(input().value).toBe("");
    expect(screen.queryByRole("button", { name: /^Remove Pasted text/ })).toBeNull();
    await typeAndSend(fixture.user, "Next request");
    expect(prompt).toHaveBeenLastCalledWith(
      expect.objectContaining({ text: "Next request", attachments: [] }),
      expect.any(Object),
    );
  });

  it("captures attachments while tool compaction is pending without consuming the next draft", async () => {
    const compacted = deliveryGate<{ sessionId: string }>();
    const toolCompact = vi.fn<Client["projectSessions"]["toolCompact"]>(() => compacted.promise);
    const prompt = vi.fn<Client["sessionChats"]["prompt"]>(async () => continuationTurnId);
    using fixture = await renderComposer({
      projectSessions: { toolCompact },
      sessionChats: { prompt },
    });
    await pasteAttachment(fixture.user, "sent");
    await typeAndSend(fixture.user, "/toolcompact Review the log");
    expect(input().value).toBe("");
    expect(prompt).not.toHaveBeenCalled();
    await fixture.user.type(input(), "Next message");
    await pasteAttachment(fixture.user, "next");
    await act(async () => compacted.resolve({ sessionId }));
    await waitFor(() => expect(prompt).toHaveBeenCalledOnce());
    expect(prompt.mock.calls[0]?.[0]).toMatchObject({
      text: "Review the log",
      attachments: [textAttachment("sent")],
    });
    expect(input().value).toBe("Next message");
    expect(screen.getAllByRole("button", { name: /^Remove Pasted text/ })).toHaveLength(1);
    await fixture.user.click(screen.getByRole("button", { name: "Send" }));
    expect(prompt.mock.calls[1]?.[0]).toMatchObject({
      text: "Next message",
      attachments: [textAttachment("next")],
    });
  });

  it("restores the whole command on compaction failure and sends its attachment once on retry", async () => {
    const toolCompact = vi
      .fn<Client["projectSessions"]["toolCompact"]>()
      .mockRejectedValueOnce(new Error("Navigation failed"))
      .mockResolvedValue({ sessionId });
    const prompt = vi.fn<Client["sessionChats"]["prompt"]>(async () => continuationTurnId);
    using fixture = await renderComposer({
      projectSessions: { toolCompact },
      sessionChats: { prompt },
    });
    await pasteAttachment(fixture.user, "reference");
    await typeAndSend(fixture.user, "/toolcompact Review the log");
    await waitFor(() => expect(input().value).toBe("/toolcompact Review the log"));
    expect(screen.getAllByRole("button", { name: /^Remove Pasted text/ })).toHaveLength(1);
    expect(prompt).not.toHaveBeenCalled();
    await fixture.user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(prompt).toHaveBeenCalledOnce());
    expect(prompt.mock.calls[0]?.[0]).toMatchObject({
      text: "Review the log",
      attachments: [textAttachment("reference")],
    });
  });

  it("retries failed continuation admission with the attachment without compacting again", async () => {
    const toolCompact = vi.fn<Client["projectSessions"]["toolCompact"]>(async () => ({
      sessionId,
    }));
    const prompt = vi
      .fn<Client["sessionChats"]["prompt"]>()
      .mockRejectedValueOnce(new Error("Admission failed"))
      .mockResolvedValue(continuationTurnId);
    using fixture = await renderComposer({
      projectSessions: { toolCompact },
      sessionChats: { prompt },
    });
    await pasteAttachment(fixture.user, "reference");
    await typeAndSend(fixture.user, "/toolcompact Review the log");
    expect(await screen.findByText("Admission failed")).toBeDefined();
    expect(input().value).toBe("Review the log");
    expect(screen.getAllByRole("button", { name: /^Remove Pasted text/ })).toHaveLength(1);
    await fixture.user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(prompt).toHaveBeenCalledTimes(2));
    expect(toolCompact).toHaveBeenCalledOnce();
    expect(prompt.mock.calls.map(([input]) => input.attachments)).toEqual([
      [textAttachment("reference")],
      [textAttachment("reference")],
    ]);
  });

  it("does not submit a captured continuation after the renderer cancels tool compaction", async () => {
    const compacted = deliveryGate<{ sessionId: string }>();
    const toolCompact = vi.fn<Client["projectSessions"]["toolCompact"]>(() => compacted.promise);
    const prompt = vi.fn<Client["sessionChats"]["prompt"]>();
    const fixture = await renderComposer({
      projectSessions: { toolCompact },
      sessionChats: { prompt },
    });
    await pasteAttachment(fixture.user, "reference");
    await typeAndSend(fixture.user, "/toolcompact Review the log");
    fixture[Symbol.dispose]();
    expect(toolCompact.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    await act(async () => compacted.resolve({ sessionId }));
    expect(prompt).not.toHaveBeenCalled();
  });

  it("replaces implicit editor context with an explicit note at the same range and reveals context when removed", async () => {
    const prompt = vi.fn<Client["sessionChats"]["prompt"]>(async () =>
      TurnId.make("10000000-0000-4000-8000-000000000001"),
    );
    using fixture = await renderComposer({ sessionChats: { prompt } }, { editor: true });
    fixture.annotateEditor("Rounding?");
    await fixture.user.click(screen.getByRole("button", { name: /^src\/active\.ts/ }));
    expect(screen.getByText("Rounding?")).toBeDefined();
    expect(screen.getAllByRole("button", { name: /Remove.*active.ts/ })).toHaveLength(1);
    fixture.annotateEditor("Off by one?");
    expect(screen.queryByText("Rounding?")).toBeNull();
    expect(screen.getByText("Off by one?")).toBeDefined();
    await fixture.user.click(screen.getByRole("button", { name: /Remove.*active.ts/ }));
    expect(screen.queryByText("Off by one?")).toBeNull();
    expect(screen.getByRole("button", { name: /Remove.*active.ts/ })).toBeDefined();
    await fixture.user.click(screen.getByRole("button", { name: /Remove.*active.ts/ }));
    expect(screen.queryByRole("button", { name: /Remove.*active.ts/ })).toBeNull();
    fixture.selectEditor("src/active.ts");
    fixture.annotateEditor("Explain rounding");
    await typeAndSend(fixture.user, "Explain this");
    await waitFor(() => expect(prompt).toHaveBeenCalled());
    expect(prompt.mock.calls[0]?.[0].attachments).toEqual([
      expect.objectContaining({
        kind: "source",
        comment: "Explain rounding",
        selectedText: "return total;",
        location: source.location,
      }),
    ]);
    expect(screen.queryByRole("button", { name: /Remove.*active.ts/ })).toBeNull();
  });

  // Sender-neutral queue policy and per-item steering cancellation are exercised
  // with the real runtime projection in prompt-queue-workflow.test.tsx.
});
