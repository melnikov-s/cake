import { Schema } from "effect";
import { subagentLink } from "../subagents/subagent-reference";

const id = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));

/** Pending handoff intent, not a transcript. Detailed worker history stays with Pi. */
export const PendingReport = Schema.Struct({
  id,
  recipientSessionId: id,
  text: Schema.String,
  source: Schema.optionalKey(
    Schema.Struct({
      kind: Schema.Literal("subagent"),
      handleId: id,
      sessionId: id,
      task: Schema.String,
      status: Schema.String,
      /** Original worker entry/part, never the recipient's reminder entry. */
      messageId: Schema.optionalKey(id),
    }),
  ),
  admissions: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
});
export interface PendingReport extends Schema.Schema.Type<typeof PendingReport> {}

/** Public retained conversation, optionally at the exact final answer. Private Pi IDs are provenance. */
export function pendingReportRef(report: PendingReport): string | undefined {
  const source = report.source;
  return source
    ? subagentLink(report.recipientSessionId, source.handleId, source.messageId)
    : undefined;
}

/** A receipt names visible Pi evidence; it does not claim semantic verification. */
export const ReportHandlingReceipt = Schema.Struct({
  id,
  recipientSessionId: id,
  assistantPartId: id,
  disposition: Schema.Literals(["communicated", "dismissed"]),
});
export interface ReportHandlingReceipt extends Schema.Schema.Type<typeof ReportHandlingReceipt> {}

export const PendingReportRead = Schema.Struct({
  id,
  offset: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 8000 }))),
});
export interface PendingReportRead extends Schema.Schema.Type<typeof PendingReportRead> {}

export const PendingReportAcknowledge = Schema.Struct({
  ids: Schema.Array(id).check(Schema.isMinLength(1), Schema.isMaxLength(20), Schema.isUnique()),
  disposition: ReportHandlingReceipt.fields.disposition,
  /** Exact text already emitted to the user, not a promise of a future final answer. */
  communicatedText: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(8000)),
});
export interface PendingReportAcknowledge extends Schema.Schema.Type<
  typeof PendingReportAcknowledge
> {}
