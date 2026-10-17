import { Option, Schema } from "effect";
import {
  SessionSendBatchInput,
  SessionSendBatchReceipt,
  SessionSendBatchResult,
  type SessionSendBatchOutcome,
} from "../../contracts/conversations/session-send-batch";
import type { JsonObject, JsonValue } from "../../contracts/serialization/json-contract";
import type { CakeOperationDefinition } from "../../contracts/agent/cake-operation";

const rejectedSend = Schema.Struct({ ok: Schema.Literal(false), error: Schema.String });

/** Tool adapter only: single-send retains routing, correlation, and Pi admission authority. */
export function createSessionSendBatchOperation(
  send: (input: JsonObject, signal: AbortSignal) => Promise<JsonValue>,
): CakeOperationDefinition<SessionSendBatchInput, SessionSendBatchResult> {
  return {
    command: "sessions.send-batch",
    topic: "sessions",
    summary: "Send one shared message to multiple explicitly targeted Project Sessions.",
    guidance: [
      "Do not target members of the calling Project Session's own Session Family: intra-family communication belongs exclusively on its shared Workboard, including assignments, questions, urgent redirection and results. Cake Chat and unrelated independent sessions retain ordinary messaging rules.",
      "Supply 1–100 unique sessionIds and one text. Invalid arguments or duplicate IDs reject the whole batch before sending.",
      "Recipients are attempted sequentially in input order. Unknown targets and individual delivery failures do not stop later recipients; inspect every outcome.",
      "Omit delivery to start idle targets or queue behind active targets; steer redirects active work. From a Project Session, expectsResponse defaults to false; set true only when every recipient owes you one answer. From Cake Chat, report (digest by default, interrupt, or silent) applies to every recipient exactly as in sessions.send.",
      "Each recipient starts a separate exchange; maxMessages applies independently to each. Use sessions.send for an existing thread or a correlated reply.",
      "ok means the batch was processed, not that every delivery succeeded. status is complete, partial, or failed. Receipts are informational; no acknowledgment is needed.",
    ],
    limitations: [
      "Not atomic: accepted deliveries are never rolled back or retried. Retry only selected failed recipients after checking uncertain delivery failures, never the entire batch.",
      "Cancellation stops further attempts and reports remaining recipients as not-sent. A transport failure may leave delivery uncertain.",
      "Batch send does not forward task inputs or share a thread/reply ID across recipients.",
    ],
    inputSchema: SessionSendBatchInput,
    outputSchema: SessionSendBatchResult,
    truncateResultText: false,
    examples: [
      {
        input: {
          sessionIds: ["first-session-id", "second-session-id"],
          text: "The API review is complete; use the agreed contract.",
          expectsResponse: false,
        },
      },
    ],
    result:
      "One ordered, concise outcome per sessionId, including all failures; shared text is not echoed.",
    async execute(input, { signal }) {
      const { sessionIds, ...shared } = input;
      const outcomes: SessionSendBatchOutcome[] = [];
      let firstReceipt: SessionSendBatchReceipt | undefined;
      const failureMessage = (message: string) =>
        message.replaceAll(input.text, "[shared message]").slice(0, 1_024);
      for (const sessionId of sessionIds) {
        if (signal.aborted) {
          outcomes.push({
            sessionId,
            ok: false,
            status: "not-sent",
            error: "Batch cancelled before this recipient was attempted.",
          });
          continue;
        }
        try {
          const result = await send({ ...shared, sessionId }, signal);
          const receipt = Schema.decodeUnknownOption(SessionSendBatchReceipt)(result);
          if (Option.isSome(receipt)) {
            const { messageId, threadId, turnId, delivery, status } = receipt.value;
            firstReceipt ??= receipt.value;
            outcomes.push({
              sessionId,
              ok: true,
              messageId,
              ...(threadId ? { threadId } : null),
              ...(turnId ? { turnId } : null),
              delivery,
              status,
            });
          } else {
            const rejected = Schema.decodeUnknownOption(rejectedSend)(result);
            outcomes.push({
              sessionId,
              ok: false,
              status: "failed",
              error: Option.isSome(rejected)
                ? failureMessage(rejected.value.error)
                : "Invalid delivery receipt; delivery may have occurred. Inspect the target before retrying.",
            });
          }
        } catch (error) {
          outcomes.push({
            sessionId,
            ok: false,
            status: "failed",
            error: failureMessage(error instanceof Error ? error.message : String(error)),
          });
        }
      }
      const accepted = outcomes.filter((outcome) => outcome.ok).length;
      return {
        ok: true,
        command: "sessions.send-batch",
        status: accepted === outcomes.length ? "complete" : accepted === 0 ? "failed" : "partial",
        // The single-send authority applies the sender's defaults; echo what it accepted.
        expectsResponse: firstReceipt?.expectsResponse ?? input.expectsResponse ?? false,
        ...(firstReceipt?.report ? { report: firstReceipt.report } : null),
        outcomes,
      };
    },
  };
}
