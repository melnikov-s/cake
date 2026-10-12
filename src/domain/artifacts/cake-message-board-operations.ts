import { Schema } from "effect";
import {
  BoardAppendInput,
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
import type { CakeOperationDefinition } from "../../services/pi/runtime/cake-operation-registry";

export const createMessageBoardOperations = (
  control: MessageBoardControl,
): CakeOperationDefinition[] => [
  {
    command: "boards.append",
    topic: "boards",
    summary:
      "Append a substantive finding, decision, question, blocker, or result to the workgroup's Workboard.",
    inputSchema: BoardAppendInput,
    outputSchema: Schema.Struct({ boardId: Schema.String, entry: BoardDescription }),
    examples: [
      {
        input: {
          description: "Renderer and backend must use a distinct editor origin",
          body: "The iframe currently shares Cake's origin. Both owners need isolation before integration.",
        },
      },
    ],
    result:
      "Cake-stamped author, timestamp, sequence and description. Posting does not wake recipients.",
    limitations: [
      "Only workgroup members may append. Audience defaults to workgroup; targeted audiences must be workgroup members.",
      "Post information that changes another member's work. No routine progress, tool diaries, acknowledgments or duplicate completion reports.",
      "Entries are immutable. Correct an earlier entry by referencing its sequence in a new post. Agent decisions are not user authorization.",
      "Use direct messaging/steering for assignments, urgent redirection, or blocked-child wake-ups.",
    ],
    execute: (input) => control.append(Schema.decodeUnknownSync(BoardAppendInput)(input)),
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
      "Supply nextAfter as after to continue paging. Omit after to revisit unread entries. Previously read bodies and your own posts are excluded.",
    ],
    execute: async (input) => {
      const page = await control.readNew(Schema.decodeUnknownSync(BoardPageInput)(input));
      if (!page) throw new Error("This session has no Workboard");
      return page;
    },
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
    result: "Description, audience and combined notification/read receipts.",
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
