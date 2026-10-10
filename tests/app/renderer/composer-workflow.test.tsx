/** @vitest-environment jsdom */
import { TurnId } from "../../../src/ipc/conversation-data";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Client } from "../../../src/renderer/client/Client";
import { Chat } from "../../../src/renderer/components/chat";
import { applyConversationUpdate } from "../../../src/renderer/reducers/ConversationReducer";
import { projectRecord, sessionSummary } from "./fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "./renderer-store-fixture";
import type { TestClientOverrides } from "./test-client";

const sessionId = "session-one";
const source = {
  kind: "source" as const,
  name: "active.ts",
  location: { path: "src/active.ts", range: { start: { line: 1 }, end: { line: 2 } } },
};
const image = (name: string) => ({
  kind: "image" as const,
  name,
  mimeType: "image/png",
  data: "aW1hZ2U=",
});

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
  fixture.root.appShellStore.selectProjectSession(sessionId);
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
  it("keeps same-named local files distinct and sends only the attachment the user kept", async () => {
    const first = { kind: "file" as const, name: "notes.txt", path: "/one/notes.txt" };
    const second = { ...first, path: "/two/notes.txt" };
    const chooseAttachments = vi
      .fn<Client["filesystem"]["chooseAttachments"]>()
      .mockResolvedValueOnce([first])
      .mockResolvedValueOnce([second]);
    const prompt = vi.fn<Client["sessionChats"]["prompt"]>(async () =>
      TurnId.make("10000000-0000-4000-8000-000000000001"),
    );
    using fixture = await renderComposer({
      filesystem: { chooseAttachments },
      sessionChats: { prompt },
    });
    await fixture.user.type(input(), "Compare these");
    await fixture.user.click(screen.getByRole("button", { name: "Attach files" }));
    await fixture.user.click(screen.getByRole("button", { name: "Attach files" }));
    expect(screen.getAllByRole("button", { name: /@ notes\.txt/ })).toHaveLength(2);
    expect(input().value).toBe("Compare these");
    await fixture.user.click(screen.getAllByRole("button", { name: /@ notes\.txt/ })[0]!);
    await fixture.user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect(prompt).toHaveBeenCalledWith(
        expect.objectContaining({ text: "Compare these", attachments: [second] }),
        expect.any(Object),
      ),
    );
    expect(input().value).toBe("");
    expect(screen.queryByRole("button", { name: /@ notes\.txt/ })).toBeNull();
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
    const chooseAttachments = vi
      .fn<Client["filesystem"]["chooseAttachments"]>()
      .mockResolvedValueOnce([image("sent.png")])
      .mockResolvedValueOnce([image("next.png")]);
    using fixture = await renderComposer(
      { sessionChats: { prompt }, filesystem: { chooseAttachments } },
      { editor: true },
    );
    await fixture.user.click(screen.getByRole("button", { name: "Attach files" }));
    await typeAndSend(fixture.user, "First message");
    await fixture.user.type(input(), "Next message");
    await fixture.user.click(screen.getByRole("button", { name: "Attach files" }));
    fixture.selectEditor("src/next.ts");
    await act(async () => {
      reject(new Error("Send failed"));
      await pending.catch(() => undefined);
    });
    expect(await screen.findByText("Send failed")).toBeDefined();
    expect(input().value).toBe("Next message");
    expect(screen.getByRole("button", { name: "Remove next.png" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Remove sent.png" })).toBeDefined();
    expect(screen.getByRole("button", { name: /Remove.*next.ts/ })).toBeDefined();
    await fixture.user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(prompt).toHaveBeenCalledTimes(2));
    expect(prompt.mock.calls[1]?.[0]).toMatchObject({
      text: "Next message",
      attachments: expect.arrayContaining([
        image("next.png"),
        image("sent.png"),
        expect.objectContaining({
          kind: "source",
          location: expect.objectContaining({ path: "src/next.ts" }),
        }),
      ]),
    });
  });

  it("tool-compacts without consuming explicit attachments or rejecting implicit editor context", async () => {
    const toolCompact = vi.fn<Client["projectSessions"]["toolCompact"]>(async () => ({
      sessionId,
    }));
    using fixture = await renderComposer(
      {
        projectSessions: { toolCompact },
        filesystem: { chooseAttachments: async () => [image("reference.png")] },
      },
      { editor: true },
    );
    await fixture.user.click(screen.getByRole("button", { name: "Attach files" }));
    await typeAndSend(fixture.user, "/toolcompact Continue cleanly");
    await waitFor(() =>
      expect(toolCompact).toHaveBeenCalledWith(
        {
          sessionId,
          workingDirectory: "/project",
          entryId: "assistant-entry",
          prompt: "Continue cleanly",
        },
        expect.any(Object),
      ),
    );
    expect(input().value).toBe("");
    expect(screen.getByRole("button", { name: "Remove reference.png" })).toBeDefined();
  });

  it("replaces implicit editor context with an explicit note at the same range and reveals context when removed", async () => {
    const prompt = vi.fn<Client["sessionChats"]["prompt"]>(async () =>
      TurnId.make("10000000-0000-4000-8000-000000000001"),
    );
    using fixture = await renderComposer({ sessionChats: { prompt } }, { editor: true });
    fixture.annotateEditor("Rounding?");
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

  it("shows usage for an empty side-chat command without consuming the draft", async () => {
    using fixture = await renderComposer();
    await typeAndSend(fixture.user, "/sidechat");
    expect(await screen.findByText("Usage: /sidechat <prompt>")).toBeDefined();
    expect(input().value).toBe("/sidechat");
  });

  // Sender-neutral queue policy and per-item steering cancellation are exercised
  // with the real runtime projection in prompt-queue-workflow.test.tsx.
});
