import { Schema } from "effect";
import {
  sessionUsageSchema,
  uiPartSchema,
  type SessionSnapshot,
  type UiPart,
} from "./session-contract";

const bounded = (minimum: number, maximum: number) =>
  Schema.String.check(Schema.isMinLength(minimum), Schema.isMaxLength(maximum));
const boundedReviewText = Schema.String.check(Schema.isMaxLength(262_144));
const nonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const reviewPointSchema = Schema.Struct({
  diffLine: nonNegativeInt,
  oldLine: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
  newLine: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
  column: Schema.optional(nonNegativeInt),
});
const reviewAnchorSchema = Schema.Struct({
  path: bounded(1, 8_192),
  view: Schema.optional(Schema.Literals(["file", "message"])),
  start: reviewPointSchema,
  end: reviewPointSchema,
  selectedText: boundedReviewText,
  contextBefore: boundedReviewText,
  contextAfter: boundedReviewText,
  diff: boundedReviewText,
  messageId: Schema.optional(bounded(1, 256)),
  entryId: Schema.optional(bounded(1, 256)),
  startOffset: Schema.optional(nonNegativeInt),
  endOffset: Schema.optional(nonNegativeInt),
});
const pendingReviewCommentSchema = Schema.Struct({
  id: bounded(1, 256),
  body: boundedReviewText,
  createdAt: Schema.String,
});
const runBase = {
  runId: Schema.String.check(Schema.isUUID()),
  commentIds: Schema.Array(bounded(1, 256)).check(Schema.isMinLength(1)),
};
const reviewSubmissionSchema = Schema.Union([
  Schema.Struct({ ...runBase, status: Schema.Literal("running"), startedAt: Schema.String }),
  Schema.Struct({ ...runBase, status: Schema.Literal("answered"), completedAt: Schema.String }),
  Schema.Struct({
    ...runBase,
    status: Schema.Literal("failed"),
    failedAt: Schema.String,
    error: boundedReviewText,
  }),
]);
export const reviewThreadRecordSchema = Schema.Struct({
  id: bounded(1, 256),
  workspacePath: bounded(1, 4_096),
  sessionId: bounded(1, 256),
  agentSessionId: Schema.optional(bounded(1, 256)),
  agentSessionFile: Schema.optional(bounded(1, 8_192)),
  usage: Schema.optional(sessionUsageSchema),
  anchor: reviewAnchorSchema,
  pendingComments: Schema.Array(pendingReviewCommentSchema).check(Schema.isMaxLength(10_000)),
  submission: Schema.optional(reviewSubmissionSchema),
  status: Schema.Literals(["open", "resolved"]),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  resolvedAt: Schema.optional(Schema.String),
});
const reviewThreadSchema = Schema.Struct({
  id: bounded(1, 256),
  workspacePath: bounded(1, 4_096),
  sessionId: bounded(1, 256),
  agentSessionId: Schema.optional(bounded(1, 256)),
  anchor: reviewAnchorSchema,
  parts: Schema.Array(uiPartSchema).check(Schema.isMaxLength(50_000)),
  usage: Schema.optional(sessionUsageSchema),
  status: Schema.Literals(["open", "resolved"]),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  resolvedAt: Schema.optional(Schema.String),
});
export type ReviewAnchor = typeof reviewAnchorSchema.Type;
export type ReviewThreadRecord = typeof reviewThreadRecordSchema.Type;
export type ReviewThread = typeof reviewThreadSchema.Type;
export interface ReviewSessionProjection {
  readonly parts: ReadonlyArray<UiPart>;
  readonly usage?: SessionSnapshot["usage"];
}
export function projectReviewThread(
  record: ReviewThreadRecord,
  projection: ReviewSessionProjection = { parts: [] },
): ReviewThread {
  return Schema.decodeUnknownSync(reviewThreadSchema)({
    id: record.id,
    workspacePath: record.workspacePath,
    sessionId: record.sessionId,
    agentSessionId: record.agentSessionId,
    anchor: record.anchor,
    parts: [
      ...projection.parts,
      ...record.pendingComments.map((comment) => ({
        id: comment.id,
        kind: "text" as const,
        role: "user" as const,
        text: comment.body,
        status: "complete" as const,
        deliveryState: "sending" as const,
      })),
    ].slice(-50_000),
    usage: projection.usage ?? record.usage,
    status: record.status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    resolvedAt: record.resolvedAt,
  });
}
