import { sessionMessageDeliveryGuidance } from "../../contracts/conversations/session-message-delivery";
import {
  SessionMessageDelivery,
  sessionMessageDeliveryCheck,
} from "../../contracts/conversations/session-message-delivery";
import {
  ResultDelivery,
  resultDeliveryGuidance,
} from "../../contracts/conversations/result-delivery";
import {
  PendingReportAcknowledge,
  PendingReportRead,
} from "../../contracts/conversations/pending-report";
import { CompletionInboxUpdate } from "../../contracts/conversations/completion-inbox";
import { compactDiscoveryGuidance } from "../../contracts/agent/discovery-result-text";
import { AgentListInput } from "../../contracts/agent/agent-list-data";
import { messageRefsSchema } from "../../contracts/conversations/message-reference";
import { inputRefsSchema } from "../../contracts/conversations/task-input";
import { promptFilesSchema, promptFilesGuidance } from "../../contracts/conversations/prompt-files";
import { Effect, Schema } from "effect";
import { CakeModelSelection } from "../../contracts/model-presets/cake-model-selection";
import { type JsonObject } from "../../contracts/serialization/json-contract";

import type { RuntimeOperationApi } from "../../contracts/agent/cake-operation-api";
import type { CakeOperationDefinition } from "../../contracts/agent/cake-operation";

import { ChildSessionAssignment } from "../../contracts/project-sessions/child-session-assignment";

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
      command: "sessions.reports",
      requires: "invokeAppControl",
      topic: "sessions",
      summary: "List pending report obligations",
      guidance: [compactDiscoveryGuidance],
      inputSchema: AgentListInput,
      examples: [{ input: {} }],
      result:
        "Compact rows of pending report IDs, admissions and available worker session/handle/status/task metadata; never report bodies.",
      execute: invokeAppControl("sessions.reports"),
    },
    {
      command: "sessions.reports.read",
      canonicalSessionIds: true,
      requires: "invokeAppControl",
      topic: "sessions",
      summary: "Read pending report slice",
      inputSchema: PendingReportRead,
      examples: [{ input: { id: "report-id" } }],
      result: "One pending handoff text slice with nextOffset; reading never acknowledges it.",
      execute: invokeAppControl("sessions.reports.read"),
    },
    {
      command: "sessions.reports.acknowledge",
      requires: "invokeAppControl",
      topic: "sessions",
      summary: "Attest visible report handling",
      guidance: [
        "Emit grouped notice first, then acknowledge IDs with exact visible communicatedText. Never planned prose/intake/unrelated replies. Dismiss only by user decision; interruption retains obligations. No wake/mutation authorization.",
      ],
      inputSchema: PendingReportAcknowledge,
      examples: [
        {
          input: {
            ids: ["report-id"],
            disposition: "communicated",
            communicatedText:
              "The investigation is ready; it found the queue is already serialized.",
          },
        },
      ],
      result:
        "Durable handling receipt anchored to existing assistant text; retries are idempotent.",
      execute: invokeAppControl("sessions.reports.acknowledge"),
    },
    {
      command: "sessions.completions",
      requires: "invokeAppControl",
      topic: "sessions",
      summary: "List pending completion decisions",
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
      summary: "Record user decision; no lifecycle action",
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
      summary: "Persist assignment and launch child",
      guidance: [
        "Use this operation—not cake subagents—when the user asks for a child session, full child Project Session, related session, or Session Family member.",
        "Required title and assignment: { description, body }. Cake reserves the child identity and persists its addressed Workboard assignment before its first turn can run. initialPrompt/bootstrap-first calls are unsupported and fail validation.",
        "The calling session becomes the child's immediate parent. Children may recursively create their own children.",
        "Omit worktreeName to share the caller's exact Working Directory. Supply worktreeName to create a Cake-managed worktree branched from the caller's current checkout.",
        "Inspect accepted/already-admitted/failed launch; intake is not completion. Retry returned requestId with unchanged assignment; canceled/admitted work never restarts. Do not wait/poll.",
        resultDeliveryGuidance,
        "Family coordination defaults to Workboard; explicit user exceptions apply. Supply substantive assignment, not discovery instructions. Startup includes it and addressed calls; no prerequisite guide reads.",
        "Board posts reach audience/root, not author. Passive completion does not replace correlated result delivery; no extra guide reads.",
        "Children start in the background by default. Set open to true to focus the child conversation in the invoking window.",
        "Omit model unless requested; configured default preset supplies complete settings, falling back to caller only if no default.",
      ],
      inputSchema: Schema.Struct({
        title: Schema.Trim.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(500))),
        assignment: ChildSessionAssignment,
        requestId: Schema.optionalKey(
          Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
        ),
        model: Schema.optionalKey(CakeModelSelection),
        resultDelivery: Schema.optionalKey(ResultDelivery),
        open: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
        worktreeName: Schema.optionalKey(
          Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,62}$/)),
        ),
      }),
      examples: [
        {
          input: {
            title: "Storage implementation",
            assignment: {
              description: "Implement the storage slice",
              body: "Own the storage files and tests. Post your commit, verification and any blockers on the Workboard addressed to the parent.",
            },
            resultDelivery: "reply",
            open: true,
          },
          description:
            "Dependent implementation: queue a parent continuation on confirmed completion, without blocking. Use notification instead for background review.",
        },
      ],
      result:
        "Stable child identity, requestId for retry, assignment board/sequence receipt when persisted, and launch outcome. accepted is durable intake, not completion; failed leaves a retryable reservation. already-admitted includes active/blocked/complete/failed/stopped journal state and never relaunches.",
      limitations: [
        "A child worktree always branches from the caller's current checkout; it cannot select an unrelated base.",
        "Uncommitted changes remain in the caller's checkout and do not carry into a new child worktree.",
      ],
      execute: (input, context) =>
        // SAFETY: CakeOperationRegistry parsed input with this operation's schema.
        api().createChildSession(
          input as {
            title: string;
            assignment: ChildSessionAssignment;
            requestId?: string;
            model?: CakeModelSelection;
            resultDelivery?: ResultDelivery;
            open: boolean;
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
      summary: "List family members",
      guidance: [
        "The family is derived from the calling Project Session; this operation never accepts a sessionId.",
        "Use sessions.list when sessions outside the calling session's family are needed.",
        compactDiscoveryGuidance,
      ],
      inputSchema: AgentListInput,
      examples: [{}],
      result:
        "Family/root/caller identities, then compact id/parent/status/title rows in stable tree order; next=N continues, sessions.info inspects one member.",
      execute: (input, context) =>
        api().invokeAppControl(
          "sessions.list-family",
          Schema.decodeUnknownSync(AgentListInput)(input),
          context.signal,
        ),
    },
    {
      command: "sessions.send",
      canonicalSessionIds: true,
      requires: "invokeAppControl",
      topic: "sessions",
      summary: "Message target; omission reaches Cake Chat",
      guidance: [
        promptFilesGuidance,
        "Send to projectChatId from projects.list directly; no repository/hash/history lookup. Receipt is intake/retention, not execution.",
        "Omit sessionId to reach Cake Chat from a Project Session. Questions need resultDelivery: reply; blocking decisions use sessions.reply outcome: blocked. Delivery/thread fields keep ordinary meaning.",
        "Family messaging defaults to Workboard, including descendants; explicit user exceptions apply. User replies, Cake Chat and independent sessions are unaffected.",
        "Outside the family, necessary immediate corrections steer active work by default; idle sessions start normally. Use delivery: fyi for passive batched updates, queue only for deliberately ordered future work.",
        resultDeliveryGuidance,
        sessionMessageDeliveryGuidance,
        "Set replyToMessageId when this message answers a specific request. A different or unrelated message never clears that request's response obligation.",
        "Send one substantive completion report. Never send acknowledgment-only messages or duplicate lifecycle reports; receiving a report or notification does not require a response.",
        "Delivery receipts are informational tool results. Never acknowledge a receipt; send another message only for substantive coordination.",
      ],
      inputSchema: Schema.Struct({
        sessionId: Schema.optionalKey(
          Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)).annotate({
            description:
              "Target Project Session ID or bare hexadecimal suffix. Omit to message Cake Chat, which has no session ID.",
          }),
        ),
        inputRefs: Schema.optionalKey(inputRefsSchema),
        promptFiles: Schema.optionalKey(promptFilesSchema),
        messageRefs: Schema.optionalKey(messageRefsSchema),
        text: Schema.Trim.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(100_000))),
        delivery: Schema.optionalKey(SessionMessageDelivery),
        threadId: Schema.optionalKey(Schema.String.check(Schema.isUUID(4))),
        maxMessages: Schema.optionalKey(
          Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(1_000)),
        ),
        resultDelivery: Schema.optionalKey(ResultDelivery),
        replyToMessageId: Schema.optionalKey(Schema.String.check(Schema.isUUID(4))),
      }).check(sessionMessageDeliveryCheck),
      examples: [
        {
          input: {
            sessionId: "target-session-id",
            text: "Review the API changes and report the result.",
            resultDelivery: "reply",
          },
        },
        {
          input: {
            sessionId: "target-session-id",
            text: "The review is complete.",
            delivery: "fyi",
            resultDelivery: "ignore",
            replyToMessageId: "00000000-0000-4000-8000-000000000000",
          },
        },
        {
          input: {
            text: "Should I drop the legacy column or keep it behind a flag?",
            resultDelivery: "reply",
          },
          description: "No sessionId: ask Cake Chat (and through it, the user) a question.",
        },
      ],
      result:
        "A correlated admission/retention receipt, not proof of communication. status:deferred and transcriptDelivery:pending mean retained FYI; immediate admission returns transcriptDelivery:unverified and execution:unverified. Verify transcript visibility and execution separately. No acknowledgment is needed.",
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
      summary: "Reply in current exchange",
      guidance: [
        promptFilesGuidance,
        "Family replies default to Workboard; explicit user exceptions apply. User-facing/Cake Chat/independent-session replies are unaffected.",
        resultDeliveryGuidance,
        "The originating request's resultDelivery governs how its result reaches its parent; this reply's resultDelivery controls any subsequent return to the replier. Do not request an acknowledgment merely for reporting completion.",
        "Provide replyToMessageId when more than one request may be pending. Cake otherwise selects the latest matching request in the thread.",
        "Replies to originating Cake/Project Chat need no address. outcome: completed/blocked/failed; terminal delivery waits for the turn to settle.",
        "Notification batches passively; reply queues non-interrupting continuation. outcome: blocked escalates after settling, only for a decision preventing progress.",
        "Do not reply merely to acknowledge a result, notice, confirmation, lifecycle event, or delivery receipt.",
      ],
      inputSchema: Schema.Struct({
        text: Schema.Trim.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(100_000))),
        delivery: Schema.optionalKey(SessionMessageDelivery),
        threadId: Schema.optionalKey(Schema.String.check(Schema.isUUID(4))),
        resultDelivery: Schema.optionalKey(ResultDelivery),
        replyToMessageId: Schema.optionalKey(Schema.String.check(Schema.isUUID(4))),
        promptFiles: Schema.optionalKey(promptFilesSchema),
        outcome: Schema.optionalKey(Schema.Literals(["completed", "blocked", "failed"])),
        resultKind: Schema.optionalKey(Schema.Literals(["ready", "investigation"])),
      }).check(sessionMessageDeliveryCheck),
      examples: [{ input: { text: "Completed the review; focused tests pass." } }],
      result:
        "A correlated delivery receipt with the safely bound reply target and response expectation.",
      execute: invokeAppControl("sessions.reply"),
    },
    {
      command: "sessions.thread",
      requires: "invokeAppControl",
      topic: "sessions",
      summary: "Inspect current exchange",
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
      summary: "Close current exchange",
      inputSchema: Schema.Struct({
        threadId: Schema.optionalKey(Schema.String.check(Schema.isUUID(4))),
      }),
      examples: [{ input: {} }],
      result: "A closed thread receipt and final message count.",
      execute: invokeAppControl("sessions.close-thread"),
    },
  ];
}
