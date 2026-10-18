import { Schema } from "effect";

/** One choice controls both the result obligation and parent admission. */
export const ResultDelivery = Schema.Literals(["reply", "notification", "ignore"]);
export type ResultDelivery = typeof ResultDelivery.Type;

export const resultDeliveryGuidance =
  'Choose resultDelivery: "reply" (Expect reply: application-confirmed completion automatically starts or queues a normal parent turn), "notification" (Expect notification: retain a compact result-message link for the next user message; no completion-only turn), or "ignore" (no result obligation or notification). Completion transport is application-owned; workers need not call sessions.reply. Active parent work is never steered or run concurrently. Artifact/link-only results follow the same choice. Immediate questions and explicit blockers are separate actionable messages, not final completion notifications. Durable transport is deduplicated; model explanation is not exactly-once prose.';

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
