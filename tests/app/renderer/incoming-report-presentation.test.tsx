/** @vitest-environment jsdom */
import { cleanup, screen, within } from "@testing-library/react";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it, vi } from "vitest";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  encodeCrossSessionMessage,
  type CrossSessionMessageMetadata,
} from "../../../src/contracts/conversations/cross-session-message";
import { appendMessageReferences } from "../../../src/contracts/conversations/message-reference-forwarding";
import { protectedResponseNotice } from "../../../src/contracts/conversations/reference-notification";
import { formatSessionDigestReminder } from "../../../src/contracts/cake-chats/session-digest-reminder";
import { passiveNoticeContext } from "../../../src/contracts/conversations/passive-notice";
import { updateBatchReminder } from "../../../src/contracts/conversations/update-batch";
import { internalInputEntryType } from "../../../src/services/pi/runtime/internal-input-projection";
import { projectSessionEntries } from "../../../src/services/pi/runtime/session-projection";
import { readMessageReference } from "../../../src/services/pi/runtime/message-references";
import { renderChatSurface } from "./chat-surface-workflow-fixture";

const title = "Side-chat shared to-dos and merge-back memory";
const sender = { sessionId: "producer", title, kind: "project-session" as const };
const metadata = {
  version: 1 as const,
  messageId: "10000000-0000-4000-8000-000000000001",
  threadId: "10000000-0000-4000-8000-000000000002",
  replyToMessageId: "10000000-0000-4000-8000-000000000002",
  sequence: 1,
  expectsResponse: false,
  sender,
};
const assistant = (text: string): AssistantMessage => ({
  role: "assistant",
  content: [{ type: "text", text }],
  api: "openai-responses",
  provider: "fixture",
  model: "fixture",
  timestamp: 3,
  stopReason: "stop",
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
});
afterEach(cleanup);

it.each(["receipt", "reply", "request", "digest", "UserWithReminders", "UpdateBatch"] as const)(
  "keeps one attributed incoming original through recap streaming and reload (%s)",
  async (delivery) => {
    const source = SessionManager.inMemory("/producer");
    const entryId = source.appendMessage(
      assistant("## Original findings\n\n**Keep Markdown**\n\n```ts\nconst original = true;\n```"),
    );
    const original = readMessageReference(source, { entryId });
    const ref = original.message.ref;
    const parent = SessionManager.inMemory("/project");
    const { replyToMessageId, ...requestMetadata } = metadata;
    const deliveryMetadata: CrossSessionMessageMetadata = {
      ...requestMetadata,
      sender: { ...sender, sessionId: source.getSessionId() },
      ...(delivery === "request"
        ? { expectsResponse: true, resultDelivery: "reply" as const }
        : { replyToMessageId }),
    };
    const body = appendMessageReferences(
      delivery === "receipt" ? protectedResponseNotice : "The plan is ready.",
      [ref],
    );
    if (delivery === "digest") {
      parent.appendMessage({
        role: "user",
        timestamp: 1,
        content: formatSessionDigestReminder({
          lines: [
            {
              reference: "worker",
              sessionId: "producer",
              title,
              status: "completed",
              summary: "Ready",
              resultMessageRef: ref,
            },
          ],
          interruptedReport: false,
        })!,
      });
    } else if (delivery === "UserWithReminders" || delivery === "UpdateBatch") {
      const notices = [{ id: metadata.messageId, text: body, crossSession: deliveryMetadata }];
      const text = delivery === "UserWithReminders" ? "My next question" : updateBatchReminder;
      parent.appendCustomEntry(internalInputEntryType, {
        timestamp: 1,
        origin: { _tag: delivery, text, notices },
      });
      parent.appendMessage({
        role: "user",
        timestamp: 1,
        content: `${text}\n\n${passiveNoticeContext(notices)}`,
      });
    } else {
      parent.appendMessage({
        role: "user",
        timestamp: 1,
        content: encodeCrossSessionMessage(body, deliveryMetadata),
      });
    }
    const incoming = projectSessionEntries(parent.getEntries());
    const inspect = vi.fn(async () => original);
    using fixture = renderChatSurface({ parts: incoming, client: { sessionChats: { inspect } } });
    const card = screen.getByRole("region", { name: "Message from another session" });
    const disclosure = within(card).getByRole("button", { name: title });
    expect(card.textContent).toContain("From");
    expect(inspect).not.toHaveBeenCalled();
    await fixture.user.click(disclosure);
    expect(await within(card).findByRole("heading", { name: "Original findings" })).toBeTruthy();
    expect(card.querySelector('[data-streamdown="strong"]')?.textContent).toBe("Keep Markdown");
    expect(card.querySelector("pre")?.textContent).toContain("const original = true;");
    // A recap is real assistant dialogue. Only its automatically-added source preview is redundant.
    const recap = `No code has changed. Shall we review the plan?\n\n[Full agent response](${ref})`;
    fixture.publish(
      [
        ...incoming,
        {
          id: "live",
          kind: "text",
          role: "assistant",
          status: "streaming",
          text: recap.slice(0, -4),
        },
      ],
      true,
    );
    expect(screen.getAllByRole("region", { name: "Message from another session" })).toHaveLength(1);
    expect(disclosure.getAttribute("aria-expanded")).toBe("true");
    parent.appendMessage(assistant(recap));
    // Old transcripts can additionally contain an explicit messages.present relay.
    parent.appendMessage({
      role: "toolResult",
      toolName: "cake",
      toolCallId: "present",
      content: [],
      details: { command: "messages.present", result: original.message },
      isError: false,
      timestamp: 4,
    });
    const persisted = projectSessionEntries(parent.getEntries());
    fixture.publish(persisted);
    expect(screen.getByText(/Shall we review the plan/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Full agent response" }).getAttribute("href")).toBe(
      ref,
    );
    expect(document.querySelectorAll('[data-slot="message-source"]')).toHaveLength(1);
    expect(disclosure.getAttribute("aria-expanded")).toBe("true");
    await fixture.user.click(disclosure);
    fixture.publish(projectSessionEntries(parent.getEntries()));
    expect(screen.getAllByRole("region", { name: "Message from another session" })).toHaveLength(1);
    expect(document.querySelectorAll('[data-slot="message-source"]')).toHaveLength(1);
    expect(inspect).toHaveBeenCalledOnce();
    // The receipt and assistant prose remain in Pi, independently of presentation ownership.
    expect(parent.getEntries().filter((entry) => entry.type === "message")).toHaveLength(3);
    expect(source.getEntries().filter((entry) => entry.type === "message")).toHaveLength(1);
  },
);

it("deduplicates a replayed delivery ID, not distinct messages with identical sender and text", () => {
  const parent = SessionManager.inMemory("/project");
  for (const messageId of [
    metadata.messageId,
    metadata.messageId,
    "10000000-0000-4000-8000-000000000003",
  ]) {
    parent.appendMessage({
      role: "user",
      timestamp: 1,
      content: encodeCrossSessionMessage(
        appendMessageReferences("**Identical authored message**", [
          "cake://session/producer?message=one",
        ]),
        {
          ...metadata,
          messageId,
        },
      ),
    });
  }
  using fixture = renderChatSurface({ parts: projectSessionEntries(parent.getEntries()) });
  expect(screen.getAllByRole("region", { name: "Message from another session" })).toHaveLength(2);
  expect(screen.getAllByText("Identical authored message")).toHaveLength(2);
  expect(document.querySelectorAll('[data-slot="message-source"]')).toHaveLength(2);
  fixture.publish(projectSessionEntries(parent.getEntries()));
  expect(screen.getAllByText("Identical authored message")).toHaveLength(2);
  expect(parent.getEntries().filter((entry) => entry.type === "message")).toHaveLength(3);
});

it("keeps an unrelated exact original in an attributed source card", () => {
  const parent = SessionManager.inMemory("/project");
  parent.appendMessage({
    role: "user",
    timestamp: 1,
    content: encodeCrossSessionMessage(
      appendMessageReferences(protectedResponseNotice, ["cake://session/producer?message=first"]),
      metadata,
    ),
  });
  parent.appendMessage(
    assistant("A different result: [Full agent response](cake://session/producer?message=second)"),
  );
  using fixture = renderChatSurface({ parts: projectSessionEntries(parent.getEntries()) });
  fixture.publish(projectSessionEntries(parent.getEntries()));
  expect(screen.getAllByRole("region", { name: "Message from another session" })).toHaveLength(2);
  expect(
    [...document.querySelectorAll("[data-message-reference]")].map((node) =>
      node.getAttribute("data-message-reference"),
    ),
  ).toEqual(["cake://session/producer?message=first", "cake://session/producer?message=second"]);
});
