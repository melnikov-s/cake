import { Schema } from "effect";
import { compactDiscoveryGuidance } from "../../contracts/agent/discovery-result-text";
import {
  type MessageOperationControl,
  MessageListInput,
  MessageListResult,
  MessageOpenInput,
  MessageReadInput,
  MessageReadResult,
} from "../../contracts/conversations/message-reference";
import type { CakeOperationDefinition } from "../../contracts/agent/cake-operation";

/** Shared by Project Sessions and Cake Chat; composition supplies the trusted controls. */
export function createMessageOperations(
  control: MessageOperationControl,
): CakeOperationDefinition[] {
  const exampleRef = "cake://session/session-id?message=pi-entry-id";
  return [
    {
      command: "messages.list",
      topic: "messages",
      summary:
        "List bounded message identities and attachment input metadata without reading message bodies.",
      guidance: [
        "Use a discovered Project Session ID or the permanent Cake Chat ID. Defaults to the active branch, chronological order, 25 messages; nextOffset continues the page.",
        "Each ref is an exact Pi entry reference and a clickable link. Forward it unchanged through messageRefs without reading it first.",
        "inputRefs contains only attachment identity, name, MIME type and byte length. It does not read attachment contents.",
        "Use branch: all to discover original messages on inactive or tool-compacted branches. References never follow a newer or summarized message.",
        compactDiscoveryGuidance,
      ],
      inputSchema: MessageListInput,
      outputSchema: MessageListResult,
      truncateResultText: false,
      examples: [{ input: { sessionId: "target-session-id", limit: 25 } }],
      result:
        "Compact role/active/images/timestamp/ref rows, plus input attachment rows belonging to the preceding message; total, branch and next=N. Structured data retains full message metadata.",
      execute: (input, context) =>
        control.list(Schema.decodeUnknownSync(MessageListInput)(input), context.signal),
    },
    {
      command: "messages.read",
      topic: "messages",
      summary: "Explicitly read a bounded text slice from one exact Pi message reference.",
      guidance: [
        "Reading is optional. Forwarding or opening a reference never requires a body read.",
        "Defaults to 4,000 characters; maxChars is at most 20,000. Pass nextOffset as offset to continue. No inline image bytes are returned.",
        "Reads original Pi history by entry ID, including inactive branches and pre-compaction entries. Missing or non-message entries fail rather than selecting similar text.",
        "Attachments remain input references; use attachments operations for their contents.",
      ],
      inputSchema: MessageReadInput,
      outputSchema: MessageReadResult,
      truncateResultText: false,
      examples: [{ input: { ref: exampleRef, maxChars: 4_000 } }],
      result: "Exact source metadata, bounded text, totalChars, offset, nextOffset and truncated.",
      execute: (input, context) =>
        control.read(Schema.decodeUnknownSync(MessageReadInput)(input), context.signal),
    },
    {
      command: "messages.open",
      topic: "messages",
      summary:
        "Reveal an exact message in the invoking Cake window using ordinary session navigation.",
      guidance: [
        "Uses the same user-owned Settings → Agent navigation permission and focused-pane policy as sessions.open.",
        "This does not read the source into the agent context. If navigation is disabled, offer the ref as a Markdown link for the user to open manually.",
      ],
      inputSchema: MessageOpenInput,
      examples: [{ input: { ref: exampleRef } }],
      result:
        "The existing sessions.open navigation receipt, or a truthful missing-message/disabled-navigation error.",
      execute: (input, context) =>
        control.open(Schema.decodeUnknownSync(MessageOpenInput)(input), context.signal),
    },
  ];
}
