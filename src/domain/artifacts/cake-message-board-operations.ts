import { Schema } from "effect";
import {
  BoardContinuation,
  BoardContinuationInput,
} from "../../contracts/artifacts/workboard-continuation";
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

const continuationOperations = (
  control: NonNullable<MessageBoardControl["continuation"]>,
): CakeOperationDefinition[] => [
  {
    command: "boards.continuation.get",
    topic: "boards",
    summary:
      "Inspect your own saved Workboard continuation grant, budget, cursor and execution receipt.",
    examples: [{ input: {} }],
    result: "The saved grant and independent execution receipt, or null when passive.",
    inputSchema: Schema.Struct({}),
    outputSchema: Schema.Struct({
      boardId: Schema.String,
      policy: Schema.NullOr(BoardContinuation),
    }),
    execute: () => control.get(),
  },
  {
    command: "boards.continuation.set",
    topic: "boards",
    summary:
      "Opt your coordinator into bounded continuation for future addressed completion/blocker events, or pause/disable it.",
    examples: [
      {
        input: {
          mode: "resume",
          topic: "implementation",
          awaitAuthors: ["236e7b8b"],
          maxTurns: 1,
        },
      },
    ],
    result: "The saved bounded grant; configuration returns without waiting for results.",
    inputSchema: BoardContinuationInput,
    outputSchema: Schema.Struct({
      boardId: Schema.String,
      policy: Schema.NullOr(BoardContinuation),
    }),
    guidance: [
      "Only configure resume when the user authorized dependent continuation. Default is passive. This is asynchronous: return immediately; never wait/poll. It preserves resultDelivery:ignore and creates no private reports.",
      "New grants begin after the latest existing entry; set after explicitly to include older results. Set topic and awaitAuthors for an explicit completion batch. All named authors must post event:completion on that topic; an addressed event:blocker can break the barrier. Links, prose, read receipts, self posts and workgroup broadcasts do not request turns.",
      "maxTurns defaults to one, at most ten per explicit grant. At most two Workboard continuations are outstanding process-wide and one per recipient. Active/queued parent work finishes first. Never rearm an exhausted grant without user authorization.",
      "Pause/off prevents future admission; it does not abort an already-running turn. Explicit abort pauses the grant. Resume is explicit and preserves pending delivery receipts; restart never clears the budget or cancellation history.",
      "This grant only schedules inspection and already-authorized dependent work. Completion does not grant review/merge/resolve mutations. Quiet completion notices are separate and surface after answering the next user message.",
    ],
    execute: (input, context) =>
      control.set(Schema.decodeUnknownSync(BoardContinuationInput)(input), context.toolCallId),
  },
];

export const createMessageBoardOperations = (
  control: MessageBoardControl,
): CakeOperationDefinition[] => [
  ...(control.continuation ? continuationOperations(control.continuation) : []),

  {
    command: "boards.append",
    topic: "boards",
    summary:
      "Append a substantive finding, decision, question, blocker, or result to the workgroup's Workboard.",
    guidance: [
      "Declare event: completion or blocker for an addressed result, and resultKind: ready or investigation. These typed facts may satisfy an explicitly authorized recipient continuation grant or quiet result notice; prose/links and read receipts never imply intent. Never duplicate a board result with a private report.",
    ],
    inputSchema: BoardAppendInput,
    outputSchema: Schema.Struct({ boardId: Schema.String, entry: BoardDescription }),
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
      "Cake-stamped author, timestamp, sequence and description. Posting does not wake recipients.",
    limitations: [
      "Audience is required: target affected owners using session references. Use workgroup only for genuinely shared decisions. Only workgroup members may append or be targeted.",
      "Post information that changes another member's work. No routine progress, tool diaries, acknowledgments or duplicate completion reports.",
      "Entries are immutable. Use topic plus supersedes: [sequence, ...] for corrections within the same topic (untagged originals may acquire a topic through a correction). Supersession is recipient-specific; include everyone affected by the old decision. Agent decisions are not user authorization.",
      "Establish types, signatures, file ownership, dependencies and acceptance criteria before dependent implementation. Post changes/discoveries, not repeated contract negotiation.",
      "Family assignments and their substantive results belong exclusively on this board, not in sessions.send/reply or private side channels. Include the assignment entry, outcome, commit, contract delta, integration action and verification limits; do not duplicate private completion notifications.",
      "Discover members with sessions.list-family. sessions.create-child automatically creates/joins the family board; use resultDelivery: ignore and a board-discovery bootstrap, then post the substantive assignment here. No separate board-create/join operations exist.",
      "Board posts do not wake idle members or clear existing runtime-managed report obligations. Do not use private messaging/steering as a workaround; disclose scheduling/reporting limits to the user. User-facing replies, Cake Chat and unrelated independent sessions are outside this intra-family policy.",
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
