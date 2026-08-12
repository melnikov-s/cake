import { z } from "zod";

const boundedReviewText = z.string().max(262_144);

export const reviewPointSchema = z.object({
  diffLine: z.number().int().nonnegative(),
  oldLine: z.number().int().positive().optional(),
  newLine: z.number().int().positive().optional(),
  column: z.number().int().nonnegative().optional()
});

export const reviewAnchorSchema = z.object({
  path: z.string().min(1).max(8_192),
  view: z.enum(["diff", "full", "file"]).optional(),
  start: reviewPointSchema,
  end: reviewPointSchema,
  selectedText: boundedReviewText,
  contextBefore: boundedReviewText,
  contextAfter: boundedReviewText,
  diff: boundedReviewText
});

export const reviewMessageSchema = z.object({
  id: z.string().min(1).max(256),
  role: z.enum(["user", "assistant"]),
  body: boundedReviewText,
  createdAt: z.string().datetime(),
  delivered: z.boolean().default(false),
  status: z.enum(["complete", "error"]).default("complete")
});

export const pendingReviewCommentSchema = z.object({
  id: z.string().min(1).max(256),
  body: boundedReviewText,
  createdAt: z.string().datetime()
});

export const reviewSubmissionSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("running"), runId: z.string().uuid(), commentIds: z.array(z.string().min(1).max(256)).min(1), startedAt: z.string().datetime() }),
  z.object({ status: z.literal("answered"), runId: z.string().uuid(), commentIds: z.array(z.string().min(1).max(256)).min(1), completedAt: z.string().datetime() }),
  z.object({ status: z.literal("failed"), runId: z.string().uuid(), commentIds: z.array(z.string().min(1).max(256)).min(1), failedAt: z.string().datetime(), error: boundedReviewText })
]);

export const reviewThreadRecordSchema = z.object({
  id: z.string().min(1).max(256),
  workspacePath: z.string().min(1).max(4_096),
  sessionId: z.string().min(1).max(256),
  agentSessionId: z.string().min(1).max(256).optional(),
  agentSessionFile: z.string().min(1).max(8_192).optional(),
  anchor: reviewAnchorSchema,
  pendingComments: z.array(pendingReviewCommentSchema).max(10_000),
  submission: reviewSubmissionSchema.optional(),
  status: z.enum(["open", "resolved"]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  resolvedAt: z.string().datetime().optional()
});

export const reviewThreadSchema = z.object({
  id: z.string().min(1).max(256),
  workspacePath: z.string().min(1).max(4_096),
  sessionId: z.string().min(1).max(256),
  agentSessionId: z.string().min(1).max(256).optional(),
  anchor: reviewAnchorSchema,
  messages: z.array(reviewMessageSchema).max(10_000),
  status: z.enum(["open", "resolved"]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  resolvedAt: z.string().datetime().optional()
});

export type ReviewPoint = z.infer<typeof reviewPointSchema>;
export type ReviewAnchor = z.infer<typeof reviewAnchorSchema>;
export type ReviewMessage = z.infer<typeof reviewMessageSchema>;
export type PendingReviewComment = z.infer<typeof pendingReviewCommentSchema>;
export type ReviewSubmission = z.infer<typeof reviewSubmissionSchema>;
export type ReviewThreadRecord = z.infer<typeof reviewThreadRecordSchema>;
export type ReviewThread = z.infer<typeof reviewThreadSchema>;

export function projectReviewThread(record: ReviewThreadRecord, messages: ReviewMessage[] = []): ReviewThread {
  return reviewThreadSchema.parse({
    id: record.id,
    workspacePath: record.workspacePath,
    sessionId: record.sessionId,
    agentSessionId: record.agentSessionId,
    anchor: record.anchor,
    messages: [
      ...messages,
      ...record.pendingComments.map((comment) => ({ ...comment, role: "user" as const, delivered: false, status: "complete" as const }))
    ],
    status: record.status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    resolvedAt: record.resolvedAt
  });
}
