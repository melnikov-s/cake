import { act } from "@testing-library/react";
import type { Attachment, UiPart } from "../../../src/contracts/conversations/session-contract";
import type { QueuedConversationMessages } from "../../../src/contracts/conversations/conversation-data";
import { chatSessionId, renderChatSurface } from "./chat-surface-workflow-fixture";
import type { TestClientOverrides } from "./test-client";

export const queueSessionId = chatSessionId;
export type QueuePart = Extract<UiPart, { kind: "text" }>;
export function queuePart(
  index: number,
  text: string,
  options: {
    lane?: "queued" | "steering";
    agent?: boolean;
    /** A worker report Cake admitted to this queue. */
    report?: boolean;
    turnId?: string;
    command?: string;
    attachments?: readonly Attachment[];
    markdown?: boolean;
  } = {},
): QueuePart {
  const part: QueuePart = {
    id: `queued-${index}`,
    kind: "text",
    role: "user",
    text,
    status: "complete",
    deliveryState: options.lane ?? "queued",
    queuedInput: {
      itemId: `20000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      text,
      attachments: [...(options.attachments ?? [])],
      renderUserMessageAsMarkdown: options.markdown ?? false,
    },
  };
  if (options.markdown) Object.assign(part, { renderAs: "markdown" });
  if (options.command) Object.assign(part.queuedInput!, { command: options.command });
  if (options.turnId) Object.assign(part.queuedInput!, { turnId: options.turnId });
  if (options.report) Object.assign(part.queuedInput!, { internal: "SubagentCompletion" });
  if (options.agent)
    Object.assign(part, {
      crossSession: {
        version: 1,
        messageId: "f6debbbd-ced1-4a12-b0f7-fb60c292c623",
        threadId: "8358c2b7-bd3c-42ee-9fec-fcb726b66c18",
        sequence: 1,
        expectsResponse: false,
        sender: { kind: "project-session", sessionId: "source-session", title: "API review" },
      },
    });
  return part;
}

// The Pi queue engine has its own service integration tests. Here its typed
// authority boundary publishes realistic records; no partial AgentSession or
// second implementation of Pi's queue policy belongs in a renderer fixture.
export function renderQueue(parts: QueuePart[], client: TestClientOverrides) {
  const fixture = renderChatSurface({ parts, snapshot: { streaming: true }, client });
  return {
    user: fixture.user,
    models: fixture.models,
    publish(parts: QueuePart[]): QueuedConversationMessages {
      act(() => fixture.publish(parts, true));
      return {
        steering: parts
          .filter((part) => part.deliveryState === "steering")
          .map((part) => part.text),
        followUp: parts.filter((part) => part.deliveryState === "queued").map((part) => part.text),
      };
    },
    [Symbol.dispose]() {
      fixture[Symbol.dispose]();
    },
  };
}
