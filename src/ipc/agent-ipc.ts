import { z } from "zod";
import {
  attachmentSchema,
  changedFileSchema,
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
    sessionId: z.string().min(1).max(256).optional(),
    sessionFile: z.string().max(4_096).optional()
  }),
  z.object({ type: z.literal("rename-session"), requestId: z.uuid(), workspacePath: z.string().max(4_096), sessionId: z.string().max(256), name: z.string().min(1).max(512) }),
  z.object({ type: z.literal("fork-session"), requestId: z.uuid(), workspacePath: z.string().max(4_096), sessionId: z.string().max(256), entryId: z.string().max(256) }),
  z.object({ type: z.literal("navigate-session"), requestId: z.uuid(), workspacePath: z.string().max(4_096), sessionId: z.string().max(256), entryId: z.string().max(256) }),
  z.object({ type: z.literal("inspect-changes"), requestId: z.uuid(), workspacePath: z.string().max(4_096) }),
  z.object({ type: z.literal("terminal-start"), requestId: z.uuid(), workspacePath: z.string().max(4_096), terminalId: z.string().max(256), cols: z.number().int().min(20).max(500), rows: z.number().int().min(5).max(200) }),
  z.object({ type: z.literal("terminal-input"), requestId: z.uuid(), workspacePath: z.string().max(4_096), terminalId: z.string().max(256), data: z.string().max(65_536) }),
  z.object({ type: z.literal("terminal-resize"), requestId: z.uuid(), workspacePath: z.string().max(4_096), terminalId: z.string().max(256), cols: z.number().int().min(20).max(500), rows: z.number().int().min(5).max(200) }),
  z.object({ type: z.literal("terminal-close"), requestId: z.uuid(), workspacePath: z.string().max(4_096), terminalId: z.string().max(256) }),
  z.object({
    type: z.literal("prompt"),
    requestId: z.uuid(),
    text: z.string().min(1).max(262_144),
    delivery: z.enum(["prompt", "steer", "follow-up"]),
    attachments: z.array(attachmentSchema).max(20),
    workspacePath: z.string().max(4_096),
    sessionId: z.string().max(256)
  }),
  z.object({ type: z.literal("abort"), requestId: z.uuid(), workspacePath: z.string().max(4_096), sessionId: z.string().max(256) }),
  z.object({
    type: z.literal("set-model"),
    requestId: z.uuid(),
    provider: z.string().max(256),
    modelId: z.string().max(512), workspacePath: z.string().max(4_096), sessionId: z.string().max(256)
  }),
  z.object({ type: z.literal("set-thinking"), requestId: z.uuid(), level: thinkingLevelSchema, workspacePath: z.string().max(4_096), sessionId: z.string().max(256) }),
  z.object({
    type: z.literal("login"),
    requestId: z.uuid(),
    provider: z.string().max(256),
    authType: z.enum(["api_key", "oauth"]), workspacePath: z.string().max(4_096), sessionId: z.string().max(256)
  }),
  z.object({ type: z.literal("logout"), requestId: z.uuid(), provider: z.string().max(256), workspacePath: z.string().max(4_096), sessionId: z.string().max(256) }),
  z.object({
    type: z.literal("ui-response"),
    requestId: z.uuid(),
    uiRequestId: z.uuid(),
    value: z.string().max(262_144).optional(),
    cancelled: z.boolean(), workspacePath: z.string().max(4_096), sessionId: z.string().max(256)
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
  z.object({ type: z.literal("changes-snapshot"), requestId: z.uuid(), workspacePath: z.string().max(4_096), files: z.array(changedFileSchema).max(10_000) }),
  z.object({ type: z.literal("terminal-output"), workspacePath: z.string().max(4_096), terminalId: z.string().max(256), data: z.string().max(262_144) }),
  z.object({ type: z.literal("terminal-exited"), workspacePath: z.string().max(4_096), terminalId: z.string().max(256), exitCode: z.number().int() }),
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
