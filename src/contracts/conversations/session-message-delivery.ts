import { Schema } from "effect";

/** Outbound intent, independent of the completion's return resultDelivery. */
export const SessionMessageDelivery = Schema.Literals(["fyi", "prompt", "steer", "queue"]);
export type SessionMessageDelivery = typeof SessionMessageDelivery.Type;

export const sessionMessageDeliveryGuidance =
  'Minimize cross-session messages. For authorized routine FYIs use delivery: "fyi": the passive update is batched: it rides along with the next user message or, if none arrives, joins one batched turn delivered within 5 minutes (sooner, just before the prompt cache is estimated to expire). It never steers or runs beside active work and has no execution/result obligation. For necessary immediate corrections omit delivery: active work is steered, idle sessions start normally. Use "prompt" for an immediate assignment/question, or "queue" only for deliberately ordered future work. Return resultDelivery is separate and defaults to notification. Never send acknowledgments, receipt replies, or resolution confirmations.';

export function immediateDelivery(
  streaming: boolean | undefined,
  delivery?: SessionMessageDelivery,
) {
  return delivery ?? (streaming ? "steer" : "prompt");
}
