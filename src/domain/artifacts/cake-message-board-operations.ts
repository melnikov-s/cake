import { Schema } from "effect";
import { BoardDelivery } from "../../contracts/artifacts/board-delivery";
import {
  BoardAppendInput,
  BoardCurrentInput,
  BoardDescription,
  BoardDescriptionPage,
  BoardEntryReceipts,
  BoardPageInput,
  BoardReadInput,
  BoardReadResult,
  BoardSequence,
  BoardSessionId,
  BoardSessionReceipts,
} from "../../contracts/artifacts/message-board";
import type { MessageBoardControl } from "../../contracts/artifacts/message-board-control";
import type { CakeOperationDefinition } from "../../contracts/agent/cake-operation";

export const createMessageBoardOperations = (
  control: MessageBoardControl,
): CakeOperationDefinition[] => [
  {
    command: "boards.append",
    topic: "boards",
    summary:
      "Append a substantive finding, decision, question, blocker, or result to the workgroup's Workboard.",
    guidance: [
      "Every new post routes to explicit recipients plus the unique family root, once each and never the author. Broadcasts automatically reach only the root. Idle recipients receive coalesced durable wakes; active/queued recipients receive context-only reminders at before_agent_start/turn_end, with durable idle fallback. No event or wakeup wording is required. Never abort, force send-now or steer unrelated user work. Tool retries use requestId (default tool-call ID). Inspect delivery status, not posting alone; stop/cancel/resolve authority remains intact.",
      "Declare event: completion or blocker for an addressed result, and resultKind: ready or investigation. These typed facts retain quiet completion decisions; default board delivery needs no continuation grant; prose/links and read receipts never imply intent. Never duplicate a board result with a private report.",
    ],
    inputSchema: BoardAppendInput,
    outputSchema: Schema.Struct({
      boardId: Schema.String,
      entry: BoardDescription,
      deliveries: Schema.optionalKey(Schema.Array(BoardDelivery)),
      scheduledRecipients: Schema.optionalKey(Schema.Array(Schema.String)),
    }),
    examples: [
      {
        input: {
          description: "Renderer and backend must use a distinct editor origin",
          body: "The iframe currently shares Cake's origin. Both owners need isolation before integration.",
          audience: ["236e7b8b", "7d87c268"],
          topic: "editor-origin",
        },
      },
    ],
    result:
      "Cake-stamped entry, scheduledRecipients and existing per-recipient batch deliveries. pending is scheduled; admitted is queue intake; notified is confirmed model-request intake—not successful work. entry-receipts shows updated status.",
    limitations: [
      "Audience is required: target affected owners using session references. Use workgroup only for genuinely shared decisions. Only workgroup members may append or be targeted.",
      "Post information that changes another member's work. No routine progress, tool diaries, acknowledgments or duplicate completion reports.",
      "Entries are immutable. Use topic plus supersedes: [sequence, ...] for corrections within the same topic (untagged originals may acquire a topic through a correction). Supersession is recipient-specific; include everyone affected by the old decision. Agent decisions are not user authorization.",
      "Establish types, signatures, file ownership, dependencies and acceptance criteria before dependent implementation. Post changes/discoveries, not repeated contract negotiation.",
      "By default family assignments and their substantive results belong exclusively on this board, not in sessions.send/reply or private side channels. Include the assignment entry, outcome, commit, contract delta, integration action and verification limits; do not duplicate private completion notifications.",
      "Discover members with sessions.list-family. sessions.create-child requires assignment: { description, body } and persists it addressed to the new child before launch; resultDelivery defaults to ignore. Post later coordination and results here. No separate board-create/join operations exist.",
      "All posts use default addressed/root delivery; no post clears existing private report obligations. Current explicit user exceptions override Cake communication defaults, including injected policies; genuine platform limits and tool capabilities still apply. Use supported tools and execution evidence, not a blanket harness refusal.",
    ],
    execute: (input, context) => {
      const decoded = Schema.decodeUnknownSync(BoardAppendInput)(input);
      return control.append({ ...decoded, requestId: decoded.requestId ?? context.toolCallId });
    },
  },
  {
    command: "boards.read-new",
    topic: "boards",
    summary: "Discover a bounded page of relevant unread descriptions, including deferred entries.",
    inputSchema: BoardPageInput,
    outputSchema: BoardDescriptionPage,
    examples: [{ input: { limit: 20 } }],
    result: "Descriptions, nextAfter and hasMore; bodies are not marked read.",
    limitations: [
      "Supply nextAfter as after to continue paging. Omit after to revisit unread entries. Previously read bodies, superseded entries and your own posts are excluded.",
    ],
    execute: async (input) => {
      const page = await control.readNew(Schema.decodeUnknownSync(BoardPageInput)(input));
      if (!page) throw new Error("This session has no Workboard");
      return page;
    },
  },
  {
    command: "boards.current",
    topic: "boards",
    summary: "Discover current relevant decisions without replaying superseded negotiations.",
    inputSchema: BoardCurrentInput,
    outputSchema: BoardDescriptionPage,
    examples: [{ input: { topic: "editor-origin", limit: 20 } }],
    result:
      "A bounded page of non-superseded descriptions, independent of read receipts. Bodies remain opt-in through boards.read.",
    limitations: [
      "Current means not explicitly superseded, not verified or agreed. Multiple live proposals may coexist. Targeted replacements only supersede for their recipients; original entries remain inspectable.",
      "Supply nextAfter as after to continue paging. Query without after to refresh current decisions after compaction. No read receipt is recorded by this query.",
    ],
    execute: (input) => control.current(Schema.decodeUnknownSync(BoardCurrentInput)(input)),
  },
  {
    command: "boards.read",
    topic: "boards",
    summary: "Read selected entry bodies from the Workboard.",
    inputSchema: BoardReadInput,
    outputSchema: BoardReadResult,
    truncateResultText: false,
    examples: [{ input: { sequences: [1, 3] } }],
    result: "Selected immutable bodies; supplied bodies receive agent read receipts.",
    limitations: [
      "At most ten entries per call. Reading is not understanding, agreement, action, or guaranteed memory after compaction.",
    ],
    execute: (input) => control.read(Schema.decodeUnknownSync(BoardReadInput)(input).sequences),
  },
  {
    command: "boards.entry-receipts",
    topic: "boards",
    summary:
      "Inspect who was notified of and read a particular entry, with timestamps and intended audience.",
    inputSchema: Schema.Struct({ sequence: BoardSequence }),
    outputSchema: BoardEntryReceipts,
    examples: [{ input: { sequence: 1 } }],
    result:
      "Description, audience, notification/read receipts and independent per-recipient assignment delivery status; intake is not execution or task completion.",
    execute: (input) =>
      control.entryReceipts(
        Schema.decodeUnknownSync(Schema.Struct({ sequence: BoardSequence }))(input).sequence,
      ),
  },
  {
    command: "boards.session-receipts",
    topic: "boards",
    summary: "Inspect a workgroup member's relevant entries and notification/read status.",
    inputSchema: Schema.Struct({ sessionId: BoardSessionId, ...BoardPageInput.fields }),
    outputSchema: BoardSessionReceipts,
    examples: [{ input: { sessionId: "child-session", limit: 20 } }],
    result:
      "A bounded page of descriptions with receipts; absent timestamps mean no recorded intake.",
    execute: (input) => {
      const value = Schema.decodeUnknownSync(
        Schema.Struct({ sessionId: BoardSessionId, ...BoardPageInput.fields }),
      )(input);
      return control.sessionReceipts(value.sessionId, value);
    },
  },
];
