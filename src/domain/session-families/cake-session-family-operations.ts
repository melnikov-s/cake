import {
  ParentContinuation,
  parentContinuationGuidance,
} from "../../contracts/conversations/parent-continuation";
import { CompletionInboxUpdate } from "../../contracts/conversations/completion-inbox";
import { AgentListInput } from "../../contracts/agent/agent-list-data";
import { messageRefsSchema } from "../../contracts/conversations/message-reference";
import { inputRefsSchema } from "../../contracts/conversations/task-input";
import { Effect, Schema } from "effect";
import { CakeModelSelection } from "../../contracts/model-presets/cake-model-selection";
import { type JsonObject } from "../../contracts/serialization/json-contract";

import type { RuntimeOperationApi } from "../../contracts/agent/cake-operation-api";
import type { CakeOperationDefinition } from "../../contracts/agent/cake-operation";

import { createSessionSendBatchOperation } from "../conversations/cake-session-batch-send-operation";

export function createSessionFamilyOperations(
  api: () => RuntimeOperationApi,
): CakeOperationDefinition[] {
  const invokeAppControl =
    (command: string): CakeOperationDefinition["execute"] =>
    (input, context) => {
      // SAFETY: CakeOperationRegistry decoded input with the operation's object schema.
      return api().invokeAppControl(command, input as JsonObject, context.signal);
    };
  return [
    {
      command: "sessions.completions",
      requires: "invokeAppControl",
      topic: "sessions",
      summary:
        "Page pending/deferred completion decisions in your quiet inbox; nextOffset retrieves older pages.",
      inputSchema: AgentListInput,
      examples: [{ input: {} }],
      result:
        "At most fifty own ready, blocked or investigation results with pending decisions; listing starts no work.",
      execute: invokeAppControl("sessions.completions"),
    },
    {
      command: "sessions.completions.update",
      requires: "invokeAppControl",
      topic: "sessions",
      summary:
        "Record a user decision as deferred, handled or dismissed; never performs review/merge/resolve.",
      inputSchema: CompletionInboxUpdate,
      examples: [{ input: { id: "completion-id", state: "deferred" } }],
      result:
        "Updated own inbox metadata. Completion and notice delivery are not action authorization.",
      execute: invokeAppControl("sessions.completions.update"),
    },
    {
      command: "sessions.create-child",
      requires: "createChildSession",
      topic: "sessions",
      summary: "Create and start a full child Project Session in the calling session's family.",
      guidance: [
        "Use this operation—not cake subagents—when the user asks for a child session, full child Project Session, related session, or Session Family member.",
        "Call it with input containing the required title and initialPrompt fields, not prompt. For family children, use initialPrompt only to bootstrap shared Workboard discovery; publish the substantive assignment on the board addressed to the returned child reference.",
        "The calling session becomes the child's immediate parent. Children may recursively create their own children.",
        "Omit worktreeName to share the caller's exact Working Directory. Supply worktreeName to create a Cake-managed worktree branched from the caller's current checkout.",
        "This operation returns after the initial child turn is accepted; do not wait or poll for the child, and finish the parent turn normally.",
        "Set expectsResponse: false for family children and request their result on the shared Workboard. The runtime default true creates a private automatic creator-report obligation; board posts do not clear existing obligations. Prompt policy cannot reroute those notices. Later user-started turns never report back.",
        "Creation automatically establishes/extends the family and joins its shared Workboard. Board posts are passive unless the recipient explicitly granted bounded boards.continuation.set for addressed completion/blocker events. Ordinary assignments still do not wake idle members; disclose that limit, without private messages/steering workarounds. Omit continuation on board-only children: an explicit choice creates a private result obligation even with expectsResponse: false.",
        "Pane placement defaults to none. Set placement to right or down only when the child should be opened beside the parent.",
        "Omit model unless the user explicitly asks for a specific model. When omitted, the child uses the configured default model preset's complete settings (provider, model, thinking level, and Fast mode; see models.list), not the calling session's current model. Only when no default preset is configured does it use the calling session's current settings.",
      ],
      inputSchema: Schema.Struct({
        title: Schema.Trim.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(500))),
        initialPrompt: Schema.Trim.pipe(
          Schema.check(Schema.isMinLength(1), Schema.isMaxLength(100_000)),
        ),
        model: Schema.optionalKey(CakeModelSelection),
        expectsResponse: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(true))),
        continuation: Schema.optionalKey(ParentContinuation),
        placement: Schema.Literals(["none", "right", "down"]).pipe(
          Schema.withDecodingDefaultKey(Effect.succeed("none" as const)),
        ),
        worktreeName: Schema.optionalKey(
          Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,62}$/)),
        ),
      }),
      examples: [
        {
          input: {
            title: "Storage implementation",
            initialPrompt:
              "Read workgroups.md, discover the family Workboard, and read your assignment there. Communicate with family members only on the board.",
            expectsResponse: false,
            placement: "right",
          },
          description: "Open beside the parent with the configured default model.",
        },
      ],
      result: "The stable child session identity and initial-turn launch outcome.",
      limitations: [
        "A child worktree always branches from the caller's current checkout; it cannot select an unrelated base.",
        "Uncommitted changes remain in the caller's checkout and do not carry into a new child worktree.",
      ],
      execute: (input, context) =>
        // SAFETY: CakeOperationRegistry parsed input with this operation's schema.
        api().createChildSession(
          input as {
            title: string;
            initialPrompt: string;
            model?: CakeModelSelection;
            expectsResponse: boolean;
            continuation?: ParentContinuation;
            placement: "none" | "right" | "down";
            worktreeName?: string;
          },
          context.toolCallId,
          context.signal,
        ),
    },
    {
      command: "sessions.list-family",
      requires: "invokeAppControl",
      topic: "sessions",
      summary: "List only the Project Sessions in the calling session's family.",
      guidance: [
        "The family is derived from the calling Project Session; this operation never accepts a sessionId.",
        "Use sessions.list when sessions outside the calling session's family are needed.",
      ],
      inputSchema: AgentListInput,
      examples: [{}],
      result:
        "Family/root/caller identities and a bounded member roster in stable tree order; nextOffset continues, sessions.info inspects one member.",
      execute: (input, context) =>
        api().invokeAppControl(
          "sessions.list-family",
          Schema.decodeUnknownSync(AgentListInput)(input),
          context.signal,
        ),
    },
    {
      command: "sessions.send",
      requires: "invokeAppControl",
      topic: "sessions",
      summary:
        "Send a message to an explicitly targeted Project Session in any Cake project, or omit sessionId to message Cake Chat.",
      guidance: [
        'Omit sessionId to reach Cake Chat. Cake Chat has no session ID; never pass the sender ID shown on Cake Chat\'s messages (it is labelled "cake-chat"). delivery, expectsResponse, threadId, and replyToMessageId mean the same as in sessions.reply to Cake Chat. To ask the user a question through Cake Chat, set expectsResponse: true; to report a blocker on assigned work, prefer sessions.reply with outcome: "blocked".',
        "Do not use sessions.send (including send-batch or steering) for intra-family communication. Parents, children, siblings and recursive descendants communicate exclusively through their shared Workboard. This does not restrict user-facing replies, Cake Chat or unrelated independent sessions.",
        "Outside the family, set delivery to steer to interrupt and redirect a running target. Omit delivery for normal behavior: start an idle target or queue behind an active target.",
        "expectsResponse defaults to false. Set true only when you need an answer (an assignment, question, or blocker); the recipient then owes exactly one result, or one failure/stopped notice if the turn handling this message ends without one. With false, the recipient never reports back automatically.",
        parentContinuationGuidance,
        "Set replyToMessageId when this message answers a specific request. A different or unrelated message never clears that request's response obligation.",
        "Send one substantive completion report. Never send acknowledgment-only messages or duplicate lifecycle reports; receiving a report or notification does not require a response.",
        "Delivery receipts are informational tool results. Never acknowledge a receipt; send another message only for substantive coordination.",
      ],
      inputSchema: Schema.Struct({
        sessionId: Schema.optionalKey(
          Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)).annotate({
            description:
              "Target Project Session ID or s: reference. Omit to message Cake Chat, which has no session ID.",
          }),
        ),
        inputRefs: Schema.optionalKey(inputRefsSchema),
        messageRefs: Schema.optionalKey(messageRefsSchema),
        text: Schema.Trim.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(100_000))),
        delivery: Schema.optionalKey(Schema.Literals(["prompt", "queue", "steer"])),
        threadId: Schema.optionalKey(Schema.String.check(Schema.isUUID(4))),
        maxMessages: Schema.optionalKey(
          Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(1_000)),
        ),
        expectsResponse: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
        continuation: Schema.optionalKey(ParentContinuation),
        replyToMessageId: Schema.optionalKey(Schema.String.check(Schema.isUUID(4))),
      }),
      examples: [
        {
          input: {
            sessionId: "target-session-id",
            text: "Review the API changes and report the result.",
            expectsResponse: true,
          },
        },
        {
          input: {
            sessionId: "target-session-id",
            text: "The review is complete.",
            expectsResponse: false,
            replyToMessageId: "00000000-0000-4000-8000-000000000000",
          },
        },
        {
          input: {
            text: "Should I drop the legacy column or keep it behind a flag?",
            expectsResponse: true,
          },
          description: "No sessionId: ask Cake Chat (and through it, the user) a question.",
        },
      ],
      result:
        "An informational correlated receipt with target identity, recipient context snapshot, queue facts when pending, and response expectation. No acknowledgment is needed.",
      execute: invokeAppControl("sessions.send"),
    },
    {
      ...createSessionSendBatchOperation((input, signal) =>
        api().invokeAppControl("sessions.send", input, signal),
      ),
      requires: "invokeAppControl",
    },
    {
      command: "sessions.reply",
      requires: "invokeAppControl",
      topic: "sessions",
      summary:
        "Reply to the originating session in the current open exchange without carrying its session ID.",
      guidance: [
        "Do not use sessions.reply for intra-family communication; publish results, questions and blockers exclusively on the shared Workboard. User-facing replies, Cake Chat and unrelated independent sessions retain their ordinary reporting rules.",
        "Replies default to expectsResponse=false because substantive results and informational responses do not request acknowledgment.",
        "Provide replyToMessageId when more than one request may be pending. Cake otherwise selects the latest matching request in the thread.",
        "A Project Session answering Cake Chat (including one Cake Chat launched) replies to its originating Cake Chat or Project Chat without needing to repeat its address. Optional outcome declares completed, blocked, or failed; a terminal report is delivered after the executing turn settles.",
        'Cake Chat usually asked for a quiet digest result: it is shown to the user with their next message and never interrupts them. outcome: "blocked" always reaches Cake Chat immediately; use it only when you cannot continue without a user decision.',
        "Do not reply merely to acknowledge a result, notice, confirmation, lifecycle event, or delivery receipt.",
      ],
      inputSchema: Schema.Struct({
        text: Schema.Trim.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(100_000))),
        delivery: Schema.optionalKey(Schema.Literals(["prompt", "queue", "steer"])),
        threadId: Schema.optionalKey(Schema.String.check(Schema.isUUID(4))),
        expectsResponse: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
        continuation: Schema.optionalKey(ParentContinuation),
        replyToMessageId: Schema.optionalKey(Schema.String.check(Schema.isUUID(4))),
        outcome: Schema.optionalKey(Schema.Literals(["completed", "blocked", "failed"])),
        resultKind: Schema.optionalKey(Schema.Literals(["ready", "investigation"])),
      }),
      examples: [{ input: { text: "Completed the review; focused tests pass." } }],
      result:
        "A correlated delivery receipt with the safely bound reply target and response expectation.",
      execute: invokeAppControl("sessions.reply"),
    },
    {
      command: "sessions.thread",
      requires: "invokeAppControl",
      topic: "sessions",
      summary: "Inspect participants, message count, limit, closure, and delivery states.",
      inputSchema: Schema.Struct({
        threadId: Schema.optionalKey(Schema.String.check(Schema.isUUID(4))),
      }),
      examples: [{ input: {} }],
      result: "The current Cake coordination thread projection.",
      execute: invokeAppControl("sessions.thread"),
    },
    {
      command: "sessions.close-thread",
      requires: "invokeAppControl",
      topic: "sessions",
      summary:
        "Close the current exchange so queued or late arrivals cannot cause an automatic reply.",
      inputSchema: Schema.Struct({
        threadId: Schema.optionalKey(Schema.String.check(Schema.isUUID(4))),
      }),
      examples: [{ input: {} }],
      result: "A closed thread receipt and final message count.",
      execute: invokeAppControl("sessions.close-thread"),
    },
  ];
}
