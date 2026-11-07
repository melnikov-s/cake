import { Schema } from "effect";

/** One choice controls both the result obligation and parent admission. */
export const ResultDelivery = Schema.Literals(["reply", "notification", "ignore"]);
export type ResultDelivery = typeof ResultDelivery.Type;

/** Shared reply-vs-notification choice for Project Session results and private subagents. */
export const replyOrNotificationRule =
  "Choose reply at launch for owed answers/dependent actions; notification for background review. Reply is asynchronous, needs no fresh approval and never means waiting.";

export const resultDeliveryBehavior = {
  reply:
    "Application-confirmed completion queues a non-interrupting parent continuation, behind active work; it does not wait for a new user message, block the caller, steer or run concurrently.",
  notification:
    "Completion remains passive: a compact exact result-message link joins the parent's pending batch at the next user message or one batched turn within 5 minutes, sooner before estimated prompt-cache expiry. It does not create a per-result parent continuation or interrupt active work.",
  ignore:
    "No correlated result, result notification or completion-triggered parent continuation is owed. This does not suppress separately addressed Workboard posts or necessary blockers.",
} satisfies Record<ResultDelivery, string>;

export const resultDeliveryGuidance = `Default: notification. ${replyOrNotificationRule} Completion return is separate from outbound delivery. reply queues a non-interrupting continuation; notification batches at user input/within 5 minutes; ignore owes no result. Completion is automatic: no duplicate sessions.reply/wake-up. Board completion does not clear reply obligations; questions/blockers remain immediate.`;

/** Storage/transcript migration only. New callers supply just resultDelivery. */
export function migrateResultDelivery(input: {
  readonly resultDelivery?: ResultDelivery;
  readonly continuation?: "none" | "resume";
  readonly reportPolicy?: "digest" | "interrupt";
  readonly report?: "digest" | "interrupt" | "silent";
  readonly expectsResponse?: boolean;
}): ResultDelivery {
  if (input.resultDelivery) return input.resultDelivery;
  if (input.continuation) return input.continuation === "resume" ? "reply" : "notification";
  const report = input.reportPolicy ?? input.report;
  if (report)
    return report === "interrupt" ? "reply" : report === "digest" ? "notification" : "ignore";
  return input.expectsResponse === false ? "ignore" : "reply";
}
