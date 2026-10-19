/** @vitest-environment jsdom */
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMessageOperations } from "../../../src/domain/conversations/cake-message-operations";
import { CakeOperationRegistry } from "../../../src/services/pi/runtime/cake-operation-registry";
import { readMessageReference } from "../../../src/services/pi/runtime/message-references";
import { projectSessionEntries } from "../../../src/services/pi/runtime/session-projection";
import { messageNavigationTarget } from "../../../src/contracts/conversations/message-reference";
import {
  encodeCrossSessionMessage,
  formatCrossSessionReportText,
} from "../../../src/contracts/conversations/cross-session-message";
import { formatSessionDigestReminder } from "../../../src/contracts/cake-chats/session-digest-reminder";
import { appendMessageReferences } from "../../../src/contracts/conversations/message-reference-forwarding";
import { protectedResponseNotice } from "../../../src/contracts/conversations/reference-notification";
import { Chat } from "../../../src/renderer/components/chat";
import { Message } from "../../../src/renderer/models/Message";
import { messageSnapshots } from "../../../src/renderer/reducers/SessionPartReducer";
import { createRendererStoreFixture } from "./renderer-store-fixture";
import { projectRecord, sessionSummary } from "./fixtures/catalog-fixtures";
import { applyConversationUpdate } from "../../../src/renderer/reducers/ConversationReducer";
import { isWorkLogPart } from "../../../src/utils/work-log-groups";

afterEach(cleanup);

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

describe("exact response presentation", () => {
  it("persists only source metadata, lazily renders original formatting and pages without opening the producer", async () => {
    const source = SessionManager.inMemory("/producer");
    const originalText =
      "## Detailed result\n\n**Original substance**\n\n![source image](https://example.invalid/private.png)\n\n" +
      "x".repeat(20_000) +
      "\n\nFinal original detail";
    const entryId = source.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: originalText }],
      api: "openai-responses",
      provider: "openai",
      model: "fixture",
      timestamp: 1,
      usage,
      stopReason: "stop",
    });
    const full = readMessageReference(source, { entryId });
    const ref = full.message.ref;
    const read = vi.fn(async ({ ref: inputRef, maxChars }: { ref: string; maxChars?: number }) => {
      const target = messageNavigationTarget(inputRef);
      if (target.sessionId !== source.getSessionId()) throw new Error("Source inaccessible");
      return readMessageReference(source, { entryId: target.messageId, maxChars });
    });
    const operations = new CakeOperationRegistry(
      createMessageOperations({
        read,
        list: async () => {
          throw new Error("Unexpected list");
        },
        open: async () => {
          throw new Error("Presentation must not navigate");
        },
      }),
    );
    const result = await operations.invoke(
      { command: "messages.present", input: { ref } },
      {
        signal: new AbortController().signal,
        toolCallId: "present",
        runtime: { sessionId: "parent" },
      },
    );
    expect(read).toHaveBeenCalledWith({ ref, maxChars: 1 }, expect.any(AbortSignal));
    expect(JSON.stringify(result)).not.toContain("Original substance");

    const parent = SessionManager.inMemory("/project");
    parent.appendMessage({
      role: "toolResult",
      toolName: "cake",
      toolCallId: "present",
      content: result.content,
      details: result.details,
      isError: false,
      timestamp: 2,
    });
    parent.appendMessage({
      role: "user",
      timestamp: 3,
      content: encodeCrossSessionMessage(appendMessageReferences("Worker summary", [ref]), {
        version: 1,
        messageId: crypto.randomUUID(),
        threadId: crypto.randomUUID(),
        replyToMessageId: crypto.randomUUID(),
        sequence: 1,
        expectsResponse: false,
        sender: {
          sessionId: source.getSessionId(),
          title: "Delegated review",
          kind: "project-session",
        },
      }),
    });
    const parts = projectSessionEntries(parent.getEntries());
    expect(parts[0]).toMatchObject({ kind: "tool", messageReference: ref });
    expect(isWorkLogPart(parts[0]!)).toBe(false);
    const model = Message.create(messageSnapshots(parts, "parent")[0]);
    expect(model.update(parts[0]!)).toBe(true);
    expect(model.value).toMatchObject({ messageReference: ref });

    const inspect = vi.fn(
      async (request: { entryId?: string; offset?: number; maxChars?: number }) =>
        readMessageReference(source, request),
    );
    using fixture = createRendererStoreFixture({
      projects: [projectRecord({ path: "/project" })],
      sessions: [
        sessionSummary({
          sessionId: "parent",
          projectPath: "/project",
          workingDirectory: "/project",
        }),
      ],
      client: { sessionChats: { inspect } },
    });
    const session = fixture.root.sessionRegistry.load("parent", "/project");
    applyConversationUpdate(session.model, {
      _tag: "Snapshot",
      revision: 1,
      snapshot: {
        sessionId: "parent",
        sessionFile: "/parent.jsonl",
        parts,
        models: [],
        thinkingLevel: "off",
        availableThinkingLevels: ["off"],
        streaming: false,
        diagnostics: [],
        commands: [],
        compatibility: { resources: [], diagnostics: [] },
        extensionUi: { statuses: [] },
        tree: [],
      },
    });
    const show = () =>
      render(
        <Chat
          store={session.conversationSessionStore.chatStore}
          compact
          composerFocusEnabled={false}
        />,
      );
    const user = userEvent.setup();
    let view = show();
    expect(inspect).not.toHaveBeenCalled();
    const delivered = screen.getByRole("region", { name: "Message from another session" });
    expect(delivered.textContent).toContain("Worker summary");
    expect(delivered.textContent).not.toContain("Referenced Cake messages");
    expect(delivered.textContent).not.toContain("messages.read");
    expect(delivered.textContent).not.toContain("Full original message");
    const message = within(delivered.closest("article")!);
    expect(
      message.getAllByRole("button").map((button) => button.getAttribute("aria-label")),
    ).toEqual(["Copy response"]);
    await user.click(message.getByRole("button", { name: "Copy response" }));
    expect(await navigator.clipboard.readText()).toBe("Worker summary");
    expect(inspect).not.toHaveBeenCalled();
    await user.click(screen.getAllByRole("button", { name: /Full agent response/ })[0]!);
    expect(await screen.findByRole("heading", { name: "Detailed result" })).toBeTruthy();
    expect(screen.getByText("Original substance").getAttribute("data-streamdown")).toBe("strong");
    expect(await screen.findByText(/Image.*source image/)).toBeTruthy();
    expect(screen.queryByRole("img")).toBeNull();
    expect(inspect).toHaveBeenLastCalledWith(
      expect.objectContaining({ entryId, maxChars: 20_000, offset: 0 }),
      expect.anything(),
    );
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByText(/Final original detail/)).toBeTruthy();
    expect(inspect).toHaveBeenLastCalledWith(
      expect.objectContaining({ entryId, offset: 20_000 }),
      expect.anything(),
    );
    // Copying from a later page still copies the whole original, not a truncated page.
    inspect.mockRejectedValueOnce(new Error("Source temporarily unavailable"));
    await user.click(screen.getByRole("button", { name: "Copy message" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Could not copy original message: Source temporarily unavailable",
    );
    expect(screen.getByRole("button", { name: "Copy message" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Copy message" }));
    expect(await screen.findByRole("button", { name: "Copied message" })).toBeTruthy();
    expect(await navigator.clipboard.readText()).toBe(originalText);
    expect(screen.getByText(/Final original detail/)).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Detailed result" })).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();

    // A clipboard failure must not claim success or hide the original.
    const write = vi
      .spyOn(navigator.clipboard, "writeText")
      .mockRejectedValueOnce(new Error("Clipboard unavailable"));
    await user.click(screen.getByRole("button", { name: "Copied message" }));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("Clipboard unavailable"),
    );
    expect(screen.getByRole("button", { name: "Copy message" })).toBeTruthy();
    expect(screen.getByText(/Final original detail/)).toBeTruthy();
    write.mockRestore();
    await user.click(screen.getByRole("button", { name: "Previous" }));
    expect(await screen.findByRole("heading", { name: "Detailed result" })).toBeTruthy();
    await user.click(screen.getAllByRole("button", { name: /Full agent response/ })[0]!);
    view.unmount();
    // Reprojecting the persisted original tool result reconstructs the same reference.
    expect(projectSessionEntries(parent.getEntries())[0]).toMatchObject({ messageReference: ref });
    view = show();
    expect(screen.getAllByRole("button", { name: /Full agent response/ })[0]!).toBeTruthy();
    view.unmount();
  });

  it.each(["assistant", "reply", "protected", "notification"] as const)(
    "automatically presents the exact %s source once, without reading until expansion or sending a turn",
    async (delivery) => {
      const source = SessionManager.inMemory("/producer");
      const entryId = source.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "## Original report\n\n**Exact earlier result**" }],
        api: "openai-responses",
        provider: "openai",
        model: "fixture",
        timestamp: 1,
        usage,
        stopReason: "stop",
      });
      const ref = readMessageReference(source, { entryId }).message.ref;
      // The current/latest source is not the correlated result.
      source.appendMessage({
        role: "user",
        content: "A later unrelated source message",
        timestamp: 2,
      });
      const links = `[Review findings](${ref}) and [same original](${ref}).\n\n[Producer session](cake://session/${source.getSessionId()}) · [Website](https://example.com)`;
      const parent = SessionManager.inMemory("/project");
      if (delivery === "assistant") {
        parent.appendMessage({
          role: "assistant",
          content: [{ type: "text", text: links }],
          api: "openai-responses",
          provider: "openai",
          model: "fixture",
          timestamp: 3,
          usage,
          stopReason: "stop",
        });
      } else {
        parent.appendMessage({
          role: "user",
          timestamp: 3,
          content:
            delivery === "reply" || delivery === "protected"
              ? encodeCrossSessionMessage(
                  formatCrossSessionReportText(
                    source.getSessionId(),
                    "completed",
                    delivery === "protected"
                      ? appendMessageReferences(protectedResponseNotice, [ref])
                      : links,
                  ),
                  {
                    version: 1,
                    messageId: crypto.randomUUID(),
                    threadId: crypto.randomUUID(),
                    replyToMessageId: crypto.randomUUID(),
                    sequence: 1,
                    expectsResponse: false,
                    sender: {
                      sessionId: source.getSessionId(),
                      title: "Producer session",
                      kind: "project-session",
                    },
                  },
                )
              : `${formatSessionDigestReminder({
                  lines: [
                    {
                      reference: "worker",
                      sessionId: source.getSessionId(),
                      title: "Producer session",
                      summary: "Ready",
                      status: "completed",
                      resultMessageRef: ref,
                    },
                  ],
                  running: 0,
                  interruptedReport: false,
                })}\n\nMy next real question`,
        });
      }
      const parts = projectSessionEntries(parent.getEntries());
      const inspect = vi.fn(async (request: { sessionId: string; entryId?: string }) => {
        expect(request.sessionId).toBe(source.getSessionId());
        return readMessageReference(source, request);
      });
      using fixture = createRendererStoreFixture({
        projects: [projectRecord({ path: "/project" })],
        sessions: [
          sessionSummary({
            sessionId: "parent",
            projectPath: "/project",
            workingDirectory: "/project",
          }),
        ],
        client: { sessionChats: { inspect } },
      });
      const session = fixture.root.sessionRegistry.load("parent", "/project");
      applyConversationUpdate(session.model, {
        _tag: "Snapshot",
        revision: 1,
        snapshot: {
          sessionId: "parent",
          sessionFile: "/parent.jsonl",
          parts,
          models: [],
          thinkingLevel: "off",
          availableThinkingLevels: ["off"],
          streaming: false,
          diagnostics: [],
          commands: [],
          compatibility: { resources: [], diagnostics: [] },
          extensionUi: { statuses: [] },
          tree: [],
        },
      });
      const view = render(
        <Chat
          store={session.conversationSessionStore.chatStore}
          compact
          composerFocusEnabled={false}
        />,
      );
      expect(inspect).not.toHaveBeenCalled();
      const disclosure = screen.getByRole("button", { name: /Full agent response/ });
      expect(disclosure.getAttribute("aria-expanded")).toBe("false");
      expect(view.container.querySelectorAll('[data-slot="message-source"]')).toHaveLength(1);
      const user = userEvent.setup();
      if (delivery === "protected" || delivery === "reply") {
        const delivered = screen.getByRole("region", { name: "Message from another session" });
        expect(delivered.textContent).not.toContain("cake-session-message");
        expect(delivered.textContent).not.toContain("Referenced Cake messages");
        expect(delivered.textContent).not.toContain(protectedResponseNotice);
        const message = within(delivered.closest("article")!);
        expect(
          message.getAllByRole("button").map((button) => button.getAttribute("aria-label")),
        ).toEqual(["Copy response"]);
        await user.click(message.getByRole("button", { name: "Copy response" }));
        expect(await navigator.clipboard.readText()).toBe(
          delivery === "protected" ? "Response received." : links,
        );
        expect(inspect).not.toHaveBeenCalled();
      }
      if (delivery === "assistant") {
        inspect.mockRejectedValueOnce(new Error("Source inaccessible"));
        inspect.mockResolvedValueOnce({
          ...readMessageReference(source, { entryId }),
          message: {
            ...readMessageReference(source, { entryId }).message,
            ref: ref + "-different",
          },
        });
      }
      await user.click(disclosure);
      if (delivery === "assistant") {
        expect((await screen.findByRole("alert")).textContent).toContain("Source inaccessible");
        expect(screen.queryByRole("heading", { name: "Original report" })).toBeNull();
        await user.click(screen.getByRole("button", { name: "Retry source" }));
        await waitFor(() =>
          expect(screen.getByRole("alert").textContent).toContain("different message or page"),
        );
        expect(screen.queryByRole("heading", { name: "Original report" })).toBeNull();
        await user.click(screen.getByRole("button", { name: "Retry source" }));
      }
      expect(await screen.findByRole("heading", { name: "Original report" })).toBeTruthy();
      expect(screen.getByText("Exact earlier result")).toBeTruthy();
      expect(screen.queryByText("A later unrelated source message")).toBeNull();
      expect(inspect).toHaveBeenCalledTimes(delivery === "assistant" ? 3 : 1);
      expect(inspect).toHaveBeenLastCalledWith(
        expect.objectContaining({
          sessionId: source.getSessionId(),
          entryId,
          offset: 0,
          maxChars: 20_000,
        }),
        expect.anything(),
      );
      // Expansion/collapse creates no transcript entry or completion notice.
      await user.click(disclosure);
      expect(projectSessionEntries(parent.getEntries())).toEqual(parts);
      expect(view.container.querySelectorAll('[data-slot="message-source"]')).toHaveLength(1);
      if (delivery === "assistant") {
        expect(screen.getByRole("link", { name: "Producer session" }).getAttribute("href")).toBe(
          `cake://session/${source.getSessionId()}`,
        );
        expect(screen.getByRole("link", { name: "Website" }).getAttribute("href")).toBe(
          "https://example.com/",
        );
      }
      view.unmount();
    },
  );

  it("rejects missing, inaccessible and non-exact sources rather than falling back", async () => {
    const read = vi.fn(async () => {
      throw new Error("Original source inaccessible");
    });
    const operations = new CakeOperationRegistry(
      createMessageOperations({
        read,
        list: async () => null,
        open: async () => null,
      }),
    );
    const context = {
      signal: new AbortController().signal,
      toolCallId: "present",
      runtime: { sessionId: "parent" },
    };
    await expect(
      operations.invoke(
        { command: "messages.present", input: { ref: "cake://session/source" } },
        context,
      ),
    ).rejects.toThrow();
    expect(read).not.toHaveBeenCalled();
    await expect(
      operations.invoke(
        { command: "messages.present", input: { ref: "cake://session/source?message=missing" } },
        context,
      ),
    ).rejects.toThrow("Original source inaccessible");
  });
});
