import { ParentContinuation } from "./parent-continuation";
import { Schema } from "effect";
import { CakeChatReportPolicy } from "../project-sessions/session-reporting";

const sessionId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));
const delivery = Schema.Literals(["prompt", "queue", "steer"]);

/** One message and shared options; every recipient starts its own exchange. */
export const SessionSendBatchInput = Schema.Struct({
  sessionIds: Schema.Array(sessionId).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(100),
    Schema.isUnique(),
  ),
  text: Schema.Trim.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(100_000))),
  delivery: Schema.optionalKey(delivery),
  /** Project Session senders: defaults to false. Cake Chat senders use report instead. */
  expectsResponse: Schema.optionalKey(Schema.Boolean),
  /** Cake Chat senders only; defaults to digest. */
  report: Schema.optionalKey(CakeChatReportPolicy),
  continuation: Schema.optionalKey(ParentContinuation),
  maxMessages: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(1_000)),
  ),
});
export interface SessionSendBatchInput extends Schema.Schema.Type<typeof SessionSendBatchInput> {}

/** Deliberately omit message text and large/advisory single-send projections. */
export const SessionSendBatchReceipt = Schema.Struct({
  ok: Schema.Literal(true),
  command: Schema.Literal("sessions.send"),
  messageId: sessionId,
  threadId: Schema.optionalKey(sessionId),
  turnId: Schema.optionalKey(sessionId),
  delivery,
  status: Schema.Literals([
    "accepted",
    "queued",
    "delivered",
    "processing",
    "answered",
    "deferred",
  ]),
  expectsResponse: Schema.optionalKey(Schema.Boolean),
  report: Schema.optionalKey(CakeChatReportPolicy),
  continuation: Schema.optionalKey(ParentContinuation),
});
export interface SessionSendBatchReceipt extends Schema.Schema.Type<
  typeof SessionSendBatchReceipt
> {}

export const SessionSendBatchOutcome = Schema.Union([
  Schema.Struct({
    sessionId,
    ok: SessionSendBatchReceipt.fields.ok,
    messageId: SessionSendBatchReceipt.fields.messageId,
    threadId: SessionSendBatchReceipt.fields.threadId,
    turnId: SessionSendBatchReceipt.fields.turnId,
    delivery,
    status: SessionSendBatchReceipt.fields.status,
  }),
  Schema.Struct({
    sessionId,
    ok: Schema.Literal(false),
    status: Schema.Literals(["failed", "not-sent"]),
    error: Schema.String.check(Schema.isMaxLength(1_024)),
  }),
]);
export type SessionSendBatchOutcome = Schema.Schema.Type<typeof SessionSendBatchOutcome>;

export const SessionSendBatchResult = Schema.Struct({
  ok: Schema.Literal(true),
  command: Schema.Literal("sessions.send-batch"),
  status: Schema.Literals(["complete", "partial", "failed"]),
  expectsResponse: Schema.Boolean,
  report: Schema.optionalKey(CakeChatReportPolicy),
  continuation: Schema.optionalKey(ParentContinuation),
  outcomes: Schema.Array(SessionSendBatchOutcome).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(100),
  ),
});
export interface SessionSendBatchResult extends Schema.Schema.Type<typeof SessionSendBatchResult> {}
