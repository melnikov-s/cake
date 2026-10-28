import { Schema } from "effect";

/** One choice controls both the result obligation and parent admission. */
export const ResultDelivery = Schema.Literals(["reply", "notification", "ignore"]);
export type ResultDelivery = typeof ResultDelivery.Type;

/** Shared reply-vs-notification choice for Project Session results and private subagents. */
export const replyOrNotificationRule =
  "Reply when the user awaits an answer (questions, checks, investigations, diagnoses) or you need the result for your next action. A promised answer means reply. Choose reply at launch for already-authorized dependent work; no fresh user authorization is needed merely to select it. Use notification for background work reviewed later, including background implementation. Reply does not mean blocking or waiting.";

export const resultDeliveryBehavior = {
  reply:
    "Application-confirmed completion queues a non-interrupting parent continuation, behind active work; it does not wait for a new user message, block the caller, steer or run concurrently.",
  notification:
    "Completion remains passive: a compact exact result-message link joins the parent's pending batch at the next user message or one batched turn within 5 minutes, sooner before estimated prompt-cache expiry. It does not create a per-result parent continuation or interrupt active work.",
  ignore:
    "No correlated result, result notification or completion-triggered parent continuation is owed. This does not suppress separately addressed Workboard posts or necessary blockers.",
} satisfies Record<ResultDelivery, string>;

export const resultDeliveryGuidance = `Default to resultDelivery: notification. ${replyOrNotificationRule} resultDelivery controls the completion return, independently of outbound delivery. Modes: "reply" (Expect reply): ${resultDeliveryBehavior.reply} "notification" (Expect notification): ${resultDeliveryBehavior.notification} "ignore": ${resultDeliveryBehavior.ignore} Completion transport is application-owned; workers need not call sessions.reply. A Workboard completion post does not clear a correlated reply obligation; do not add a duplicate private wake-up or report. Artifact/link-only results keep the same choice. Immediate questions/explicit blockers are separate actionable messages, not final notifications. Transport is deduplicated, not exactly-once model prose.`;

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
