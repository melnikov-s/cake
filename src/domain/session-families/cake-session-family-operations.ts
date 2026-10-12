import { Effect, Schema } from "effect";
import { CakeModelSelection } from "../../contracts/model-presets/cake-model-selection";
import { type JsonObject } from "../../contracts/serialization/json-contract";

import type { RuntimeOperationApi } from "../../contracts/agent/cake-operation-api";
import type { CakeOperationDefinition } from "../../contracts/agent/cake-operation";

import { createSessionSendBatchOperation } from "../conversations/cake-session-batch-send-operation";

export function createSessionFamilyOperations(
  api: () => RuntimeOperationApi,
): CakeOperationDefinition[] {
  const empty = Schema.Struct({});
  const invokeAppControl =
    (command: string): CakeOperationDefinition["execute"] =>
    (input, context) => {
      // SAFETY: CakeOperationRegistry decoded input with the operation's object schema.
      return api().invokeAppControl(command, input as JsonObject, context.signal);
    };
  return [
    {
      command: "sessions.create-child",
      requires: "createChildSession",
      topic: "sessions",
      summary: "Create and start a full child Project Session in the calling session's family.",
      guidance: [
        "Use this operation—not cake subagents—when the user asks for a child session, full child Project Session, related session, or Session Family member.",
        "Call it with input containing the required title and initialPrompt fields; the assignment field is initialPrompt, not prompt.",
        "The calling session becomes the child's immediate parent. Children may recursively create their own children.",
        "Omit worktreeName to share the caller's exact Working Directory. Supply worktreeName to create a Cake-managed worktree branched from the caller's current checkout.",
        "This operation returns after the initial child turn is accepted; do not wait or poll for the child, and finish the parent turn normally.",
        "Pane placement defaults to none. Set placement to right or down only when the child should be opened beside the parent.",
        "When model is omitted, the child inherits the calling session's current model, thinking level, and Fast mode setting.",
      ],
      inputSchema: Schema.Struct({
        title: Schema.Trim.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(500))),
        initialPrompt: Schema.Trim.pipe(
          Schema.check(Schema.isMinLength(1), Schema.isMaxLength(100_000)),
        ),
        model: Schema.optionalKey(CakeModelSelection),
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
            initialPrompt: "Implement the storage slice and message me when it is ready.",
            model: "Sol",
            placement: "right",
          },
          description: "Select a configured preset by name.",
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
      inputSchema: empty,
      examples: [{}],
      result:
        "The family identity, root and calling session identities, and family members in stable tree order.",
      execute: (_input, context) =>
        api().invokeAppControl("sessions.list-family", {}, context.signal),
    },
    {
      command: "sessions.send",
      requires: "invokeAppControl",
      topic: "sessions",
      summary: "Send a message to an explicitly targeted Project Session in any Cake project.",
      guidance: [
        "Set delivery to steer to interrupt and redirect a running target. Omit delivery for normal behavior: start an idle target or queue behind an active target.",
        "expectsResponse defaults to true. Use true only for an assignment, actionable coordination, blocker, or question whose missing result must be reported; set false for substantive results and informational notices.",
        "Set replyToMessageId when this message answers a specific request. A different or unrelated message never clears that request's response obligation.",
        "Send one substantive completion report. Never send acknowledgment-only messages or duplicate lifecycle reports; receiving a report or notification does not require a response.",
        "Delivery receipts are informational tool results. Never acknowledge a receipt; send another message only for substantive coordination.",
      ],
      inputSchema: Schema.Struct({
        sessionId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
        text: Schema.Trim.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(100_000))),
        delivery: Schema.optionalKey(Schema.Literals(["prompt", "queue", "steer"])),
        threadId: Schema.optionalKey(Schema.String.check(Schema.isUUID(4))),
        maxMessages: Schema.optionalKey(
          Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(1_000)),
        ),
        expectsResponse: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(true))),
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
        "Replies default to expectsResponse=false because substantive results and informational responses do not request acknowledgment.",
        "Provide replyToMessageId when more than one request may be pending. Cake otherwise selects the latest matching request in the thread.",
        "A Cake Chat-spawned Project Session replies to its originating global coordinator without needing a synthetic session ID. Optional outcome declares completed, blocked, or failed; a terminal report is delivered after the executing turn settles.",
        "Do not reply merely to acknowledge a result, notice, confirmation, lifecycle event, or delivery receipt.",
      ],
      inputSchema: Schema.Struct({
        text: Schema.Trim.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(100_000))),
        delivery: Schema.optionalKey(Schema.Literals(["prompt", "queue", "steer"])),
        threadId: Schema.optionalKey(Schema.String.check(Schema.isUUID(4))),
        expectsResponse: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
        replyToMessageId: Schema.optionalKey(Schema.String.check(Schema.isUUID(4))),
        outcome: Schema.optionalKey(Schema.Literals(["completed", "blocked", "failed"])),
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
