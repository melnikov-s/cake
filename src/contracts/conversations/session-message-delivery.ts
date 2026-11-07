import { Schema } from "effect";
import { ResultDelivery } from "./result-delivery";
import { inputRefsSchema } from "./task-input";

/** Outbound intent, independent of the completion's return resultDelivery. */
export const SessionMessageDelivery = Schema.Literals(["fyi", "prompt", "steer", "queue"]);
export type SessionMessageDelivery = typeof SessionMessageDelivery.Type;

/** Context-independent incompatibilities, checked before routing or forwarding inputs. */
export const sessionMessageDeliveryCheck = Schema.makeFilter(
  (input: {
    readonly delivery?: SessionMessageDelivery;
    readonly resultDelivery?: ResultDelivery;
    readonly inputRefs?: readonly string[];
  }) => input.delivery !== "fyi" || (input.resultDelivery !== "reply" && !input.inputRefs?.length),
  { message: "A passive FYI cannot request continuation or forward attachments" },
);

export const SessionMessageDeliveryOptions = Schema.Struct({
  delivery: Schema.optionalKey(SessionMessageDelivery),
  resultDelivery: Schema.optionalKey(ResultDelivery),
  inputRefs: Schema.optionalKey(inputRefsSchema),
}).check(sessionMessageDeliveryCheck);

export const sessionMessageDeliveryGuidance =
  "delivery: fyi is passive context, batched at user input/within 5 minutes; opening does not drain it. Busy waits for idle; stopped waits for user input. Receipts prove retention/admission, not visibility/execution. prompt assigns now; queue orders future work; omission steers active work or starts idle work. resultDelivery is separate. No acknowledgments.";

export function immediateDelivery(
  streaming: boolean | undefined,
  delivery?: SessionMessageDelivery,
) {
  return delivery ?? (streaming ? "steer" : "prompt");
}
