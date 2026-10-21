import { sessionMessageDeliveryGuidance } from "../../contracts/conversations/session-message-delivery";
import { SessionMessageDelivery } from "../../contracts/conversations/session-message-delivery";
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
      summary: "Page outstanding user-facing report obligations; listing is not handling.",
      guidance: [compactDiscoveryGuidance],
      inputSchema: AgentListInput,
      examples: [{ input: {} }],
      result:
        "Compact rows of pending report IDs, admissions and available worker session/handle/status/task metadata; never report bodies.",
      execute: invokeAppControl("sessions.reports"),
    },
    {
      command: "sessions.reports.read",
      requires: "invokeAppControl",
      topic: "sessions",
      summary: "Read a bounded slice of one pending handoff report with worker provenance.",
      inputSchema: PendingReportRead,
      examples: [{ input: { id: "report-id" } }],
      result: "One pending handoff text slice with nextOffset; reading never acknowledges it.",
      execute: invokeAppControl("sessions.reports.read"),
    },
    {
      command: "sessions.reports.acknowledge",
      requires: "invokeAppControl",
      topic: "sessions",
      summary:
        "Explicitly attest a report was communicated or user-dismissed, using already-emitted assistant text.",
      guidance: [
        "First emit one concise grouped notice as assistant text, then supply its exact communicatedText and report IDs. Never acknowledge a planned final answer, intake or unrelated reply. The backend verifies visible text exists after the latest user input, not its semantic adequacy. Dismiss only when the user explicitly chose dismissal. An omitted or interrupted notice remains pending; no wakeup or mutation is authorized.",
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
      summary:
        "Persist an addressed Workboard assignment, then start a full child Project Session.",
      guidance: [
        "Use this operation—not cake subagents—when the user asks for a child session, full child Project Session, related session, or Session Family member.",
        "Required title and assignment: { description, body }. Cake reserves the child identity and persists its addressed Workboard assignment before its first turn can run. initialPrompt/bootstrap-first calls are unsupported and fail validation.",
        "The calling session becomes the child's immediate parent. Children may recursively create their own children.",
        "Omit worktreeName to share the caller's exact Working Directory. Supply worktreeName to create a Cake-managed worktree branched from the caller's current checkout.",
        "Returns accepted, already-admitted (with durable state), or failed launch status—not proof of work or completion. On failure retry with the returned requestId and unchanged assignment; the same ID never starts canceled or previously admitted work again. Do not wait or poll.",
        'Family children default to resultDelivery: "notification"; automatic result links stay quiet until the next user input. Substantive family coordination belongs on the Workboard unless the user explicitly overrides that default. Cake supplies only the board-discovery bootstrap, never a private assignment.',
        "Every later board post routes to explicit recipients and the family root, excluding the author. Idle recipients receive coalesced durable wakes; active recipients receive context-only reminders at supported prompt boundaries, with idle fallback. No event or continuation grant is required.",
        "Pane placement defaults to none. Set placement to right or down only when the child should be opened beside the parent.",
        "Omit model unless the user explicitly asks for a specific model. When omitted, the child uses the configured default model preset's complete settings (provider, model, thinking level, and Fast mode; see models.list), not the calling session's current model. Only when no default preset is configured does it use the calling session's current settings.",
      ],
      inputSchema: Schema.Struct({
        title: Schema.Trim.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(500))),
        assignment: ChildSessionAssignment,
        requestId: Schema.optionalKey(
          Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
        ),
        model: Schema.optionalKey(CakeModelSelection),
        resultDelivery: Schema.optionalKey(ResultDelivery),
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
            assignment: {
              description: "Implement the storage slice",
              body: "Own the storage files and tests. Post your commit, verification and any blockers on the Workboard addressed to the parent.",
            },
            resultDelivery: "ignore",
            placement: "right",
          },
          description: "Open beside the parent with the configured default model.",
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
      requires: "invokeAppControl",
      topic: "sessions",
      summary:
        "Send a message to an explicitly targeted Project Session in any Cake project, or omit sessionId to message Cake Chat.",
      guidance: [
        'Omit sessionId to reach Cake Chat. Cake Chat has no session ID; never pass the sender ID shown on Cake Chat\'s messages (it is labelled "cake-chat"). delivery, resultDelivery, threadId, and replyToMessageId mean the same as in sessions.reply to Cake Chat. To ask the user a question through Cake Chat, set resultDelivery: "reply"; to report a blocker on assigned work, prefer sessions.reply with outcome: "blocked".',
        "By default do not use sessions.send (including send-batch or steering) for intra-family communication. Current explicit user exceptions override this Cake policy; supported tool capabilities and genuine platform limits still apply. Parents, children, siblings and recursive descendants communicate exclusively through their shared Workboard. This does not restrict user-facing replies, Cake Chat or unrelated independent sessions.",
        "Outside the family, necessary immediate corrections steer active work by default; idle sessions start normally. Use delivery: fyi for passive updates, queue only for deliberately ordered future work.",
        resultDeliveryGuidance,
        sessionMessageDeliveryGuidance,
        "All caller kinds default to notification; reply continuation requires deliberate choice for dependent work.",
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
        messageRefs: Schema.optionalKey(messageRefsSchema),
        text: Schema.Trim.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(100_000))),
        delivery: Schema.optionalKey(SessionMessageDelivery),
        threadId: Schema.optionalKey(Schema.String.check(Schema.isUUID(4))),
        maxMessages: Schema.optionalKey(
          Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(1_000)),
        ),
        resultDelivery: Schema.optionalKey(ResultDelivery),
        replyToMessageId: Schema.optionalKey(Schema.String.check(Schema.isUUID(4))),
      }),
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
        "By default do not use sessions.reply for intra-family communication; current explicit user exceptions override this Cake policy; publish results, questions and blockers exclusively on the shared Workboard. User-facing replies, Cake Chat and unrelated independent sessions retain their ordinary reporting rules.",
        "Replies default to resultDelivery: notification; ordinary reports never request an acknowledgment or continuation.",
        "Provide replyToMessageId when more than one request may be pending. Cake otherwise selects the latest matching request in the thread.",
        "A Project Session answering Cake Chat (including one Cake Chat launched) replies to its originating Cake Chat or Project Chat without needing to repeat its address. Optional outcome declares completed, blocked, or failed; a terminal report is delivered after the executing turn settles.",
        'Expect notification keeps final results quiet: it is shown to the user with their next message and never interrupts them. outcome: "blocked" always reaches Cake Chat immediately; use it only when you cannot continue without a user decision.',
        "Do not reply merely to acknowledge a result, notice, confirmation, lifecycle event, or delivery receipt.",
      ],
      inputSchema: Schema.Struct({
        text: Schema.Trim.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(100_000))),
        delivery: Schema.optionalKey(SessionMessageDelivery),
        threadId: Schema.optionalKey(Schema.String.check(Schema.isUUID(4))),
        resultDelivery: Schema.optionalKey(ResultDelivery),
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
