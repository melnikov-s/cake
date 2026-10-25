import { Schema } from "effect";

/** Outbound intent, independent of the completion's return resultDelivery. */
export const SessionMessageDelivery = Schema.Literals(["fyi", "prompt", "steer", "queue"]);
export type SessionMessageDelivery = typeof SessionMessageDelivery.Type;

export const sessionMessageDeliveryGuidance =
  'Minimize cross-session messages. Authorized passive FYIs use delivery: "fyi": batched with the next user message or one turn within 5 minutes, sooner before estimated prompt-cache expiry. Opening the recipient does not drain the batch. Once admitted, FYIs appear as inspectable passive-update context, not user messages. Busy recipients wait until current work settles; explicitly stopped recipients wait for the next user message. They never steer/run beside active work and owe no execution/result. ok:true/status:deferred confirms retention only; accepted confirms input admission, not transcript visibility or execution. Verify the recipient transcript separately; never claim delivery from ok:true alone. For necessary immediate corrections omit delivery: steer active work or start an idle session. Use "prompt" for immediate assignments/questions; "queue" only for deliberately ordered future work. Return resultDelivery is separate and defaults to notification. Never send acknowledgments, receipt replies or resolution confirmations.';

export function immediateDelivery(
  streaming: boolean | undefined,
  delivery?: SessionMessageDelivery,
) {
  return delivery ?? (streaming ? "steer" : "prompt");
}
