import { z } from "zod";
import {
  attachmentSchema,
  sessionSnapshotSchema,
  thinkingLevelSchema,
  uiPartSchema
} from "./session-contract";

export const agentCommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("inspect-workspace"), requestId: z.uuid(), path: z.string().max(4_096) }),
  z.object({
    type: z.literal("open-workspace"),
    requestId: z.uuid(),
    path: z.string().max(4_096),
    trusted: z.boolean(),
    newSession: z.boolean().default(false),
    sessionId: z.string().min(1).max(256).optional()
  }),
  z.object({
    type: z.literal("prompt"),
    requestId: z.uuid(),
    text: z.string().min(1).max(262_144),
    delivery: z.enum(["prompt", "steer", "follow-up"]),
    attachments: z.array(attachmentSchema).max(20)
  }),
  z.object({ type: z.literal("abort"), requestId: z.uuid() }),
  z.object({
    type: z.literal("set-model"),
    requestId: z.uuid(),
    provider: z.string().max(256),
    modelId: z.string().max(512)
  }),
  z.object({ type: z.literal("set-thinking"), requestId: z.uuid(), level: thinkingLevelSchema }),
  z.object({
    type: z.literal("login"),
    requestId: z.uuid(),
    provider: z.string().max(256),
    authType: z.enum(["api_key", "oauth"])
  }),
  z.object({ type: z.literal("logout"), requestId: z.uuid(), provider: z.string().max(256) }),
  z.object({
    type: z.literal("ui-response"),
    requestId: z.uuid(),
    uiRequestId: z.uuid(),
    value: z.string().max(262_144).optional(),
    cancelled: z.boolean()
  }),
  z.object({ type: z.literal("shutdown") })
]);

export const agentEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready") }),
  z.object({
    type: z.literal("workspace-inspected"),
    requestId: z.uuid(),
    path: z.string().max(4_096),
    trustRequired: z.boolean()
  }),
  z.object({ type: z.literal("session-snapshot"), requestId: z.uuid().optional(), snapshot: sessionSnapshotSchema }),
  z.object({ type: z.literal("part-updated"), sessionId: z.string(), part: uiPartSchema }),
  z.object({ type: z.literal("part-removed"), sessionId: z.string(), partId: z.string().max(256) }),
  z.object({ type: z.literal("session-streaming"), sessionId: z.string(), streaming: z.boolean() }),
  z.object({
    type: z.literal("ui-request"),
    requestId: z.uuid(),
    uiRequestId: z.uuid(),
    kind: z.enum(["confirm", "text", "secret", "select", "manual_code"]),
    title: z.string().max(512),
    message: z.string().max(4_096),
    placeholder: z.string().max(512).optional(),
    options: z.array(z.object({ id: z.string().max(256), label: z.string().max(512) })).max(100).optional()
  }),
  z.object({ type: z.literal("complete"), requestId: z.uuid() }),
  z.object({
    type: z.literal("fatal"),
    requestId: z.uuid().optional(),
    message: z.string().max(2_048)
  })
]);

export type AgentCommand = z.infer<typeof agentCommandSchema>;
export type AgentEvent = z.infer<typeof agentEventSchema>;
