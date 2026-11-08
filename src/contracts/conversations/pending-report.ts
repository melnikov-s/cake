import { Schema } from "effect";
import { parseSubagentLink, subagentLink } from "../subagents/subagent-reference";
import { messageReference, parseSessionLink, ReadableMessageReference } from "./message-reference";
import { parseCrossSessionMessage } from "./cross-session-message";

const id = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));

/** Pending handoff intent, not a transcript. Detailed worker history stays with Pi. */
export const PendingReport = Schema.Struct({
  id,
  recipientSessionId: id,
  text: Schema.String,
  /** Immutable original, independent of protected notification copy. */
  resultMessageRef: Schema.optionalKey(ReadableMessageReference),
  /** Exact persisted request turn answered by this response, never just its owner. */
  responseKey: Schema.optionalKey(id),
  /** Held for an explicit click on this owning chat's to-do, never an automatic reminder. */
  attentionTodoId: Schema.optionalKey(Schema.String),
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
  if (report.resultMessageRef) return report.resultMessageRef;
  const recorded = parseCrossSessionMessage(report.text)?.metadata.sourceMessageRef;
  if (recorded) return recorded;
  const source = report.source;
  return source
    ? subagentLink(report.recipientSessionId, source.handleId, source.messageId)
    : undefined;
}

/** Exact source identity for presentation only; distinct delivery/ACK obligations remain distinct. */
export function reportPresentationKey(recipientSessionId: string, ref: string | undefined) {
  if (!ref || !Schema.is(ReadableMessageReference)(ref)) return undefined;
  const session = parseSessionLink(ref);
  if (session?.messageId)
    return JSON.stringify([
      recipientSessionId,
      messageReference(session.sessionId, session.messageId),
    ]);
  const worker = parseSubagentLink(ref);
  return worker?.messageId
    ? JSON.stringify([
        recipientSessionId,
        subagentLink(worker.parentSessionId, worker.handleId, worker.messageId),
      ])
    : undefined;
}

/** Only persisted delivery/request identities establish equivalence. */
export function samePendingResponse(a: PendingReport, b: PendingReport): boolean {
  return (
    a.recipientSessionId === b.recipientSessionId &&
    (a.id === b.id || Boolean(a.responseKey && a.responseKey === b.responseKey))
  );
}

/** A receipt names visible Pi evidence; it does not claim semantic verification. */
export const ReportHandlingReceipt = Schema.Struct({
  id,
  recipientSessionId: id,
  assistantPartId: id,
  responseKey: Schema.optionalKey(id),
  /** Retain source identity after ACK so a new correlation cannot replay the same result card. */
  resultMessageRef: Schema.optionalKey(ReadableMessageReference),
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
