import { z } from "zod";
import {
  sessionUsageSchema,
  uiPartSchema,
  type SessionSnapshot,
  type UiPart,
} from "./session-contract";

const REVIEW_TEXT_MAX_LENGTH = 262_144;
const boundedReviewText = z.string().max(REVIEW_TEXT_MAX_LENGTH);

const reviewPointSchema = z.object({
  diffLine: z.number().int().nonnegative(),
  oldLine: z.number().int().positive().optional(),
  newLine: z.number().int().positive().optional(),
  column: z.number().int().nonnegative().optional(),
});

const reviewAnchorSchema = z.object({
  path: z.string().min(1).max(8_192),
  view: z.enum(["file", "message"]).optional(),
  start: reviewPointSchema,
  end: reviewPointSchema,
  selectedText: boundedReviewText,
  contextBefore: boundedReviewText,
  contextAfter: boundedReviewText,
  diff: boundedReviewText,
  messageId: z.string().min(1).max(256).optional(),
  entryId: z.string().min(1).max(256).optional(),
  startOffset: z.number().int().nonnegative().optional(),
  endOffset: z.number().int().nonnegative().optional(),
});

const pendingReviewCommentSchema = z.object({
  id: z.string().min(1).max(256),
  body: boundedReviewText,
  createdAt: z.string().datetime(),
});

const reviewSubmissionSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("running"),
    runId: z.string().uuid(),
    commentIds: z.array(z.string().min(1).max(256)).min(1),
    startedAt: z.string().datetime(),
  }),
  z.object({
    status: z.literal("answered"),
    runId: z.string().uuid(),
    commentIds: z.array(z.string().min(1).max(256)).min(1),
    completedAt: z.string().datetime(),
  }),
  z.object({
    status: z.literal("failed"),
    runId: z.string().uuid(),
    commentIds: z.array(z.string().min(1).max(256)).min(1),
    failedAt: z.string().datetime(),
    error: boundedReviewText,
  }),
]);

export const reviewThreadRecordSchema = z.object({
  id: z.string().min(1).max(256),
  workspacePath: z.string().min(1).max(4_096),
  sessionId: z.string().min(1).max(256),
  agentSessionId: z.string().min(1).max(256).optional(),
  agentSessionFile: z.string().min(1).max(8_192).optional(),
  usage: sessionUsageSchema.optional(),
  anchor: reviewAnchorSchema,
  pendingComments: z.array(pendingReviewCommentSchema).max(10_000),
  submission: reviewSubmissionSchema.optional(),
  status: z.enum(["open", "resolved"]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  resolvedAt: z.string().datetime().optional(),
});

const reviewThreadSchema = z.object({
  id: z.string().min(1).max(256),
  workspacePath: z.string().min(1).max(4_096),
  sessionId: z.string().min(1).max(256),
  agentSessionId: z.string().min(1).max(256).optional(),
  anchor: reviewAnchorSchema,
  parts: z.array(uiPartSchema).max(50_000),
  usage: sessionUsageSchema.optional(),
  status: z.enum(["open", "resolved"]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  resolvedAt: z.string().datetime().optional(),
});

export type ReviewAnchor = z.infer<typeof reviewAnchorSchema>;
export type ReviewThreadRecord = z.infer<typeof reviewThreadRecordSchema>;
export type ReviewThread = z.infer<typeof reviewThreadSchema>;

export interface ReviewSessionProjection {
  parts: UiPart[];
  usage?: SessionSnapshot["usage"];
}

export function projectReviewThread(
  record: ReviewThreadRecord,
  projection: ReviewSessionProjection = { parts: [] },
): ReviewThread {
  return reviewThreadSchema.parse({
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
