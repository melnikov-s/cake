import { Schema } from "effect";

/** One choice controls both the result obligation and parent admission. */
export const ResultDelivery = Schema.Literals(["reply", "notification", "ignore"]);
export type ResultDelivery = typeof ResultDelivery.Type;

/** Shared reply-vs-notification choice for Project Session results and private subagents. */
export const replyOrNotificationRule =
  "Reply when the user awaits an answer (questions, checks, investigations, diagnoses) or you will act on it next. A promised answer means reply. Use notification for background work reviewed later (implementation, long runs).";

export const resultDeliveryGuidance = `Default to resultDelivery: notification. ${replyOrNotificationRule} Modes: "reply" (Expect reply) starts/queues a normal parent turn on application-confirmed completion; "notification" (Expect notification) batches a compact result-message link with the next user message or one turn within 5 minutes, sooner before estimated prompt-cache expiry; "ignore" owes no result/notification. Never create a per-result notification turn, steer active parent work or run concurrently. Completion transport is application-owned; workers need not call sessions.reply. Artifact/link-only results keep the same choice. Immediate questions/explicit blockers are separate actionable messages, not final notifications. Transport is deduplicated, not exactly-once model prose.`;

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
