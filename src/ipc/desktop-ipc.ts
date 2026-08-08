import { z } from "zod";
import { agentEventSchema } from "./agent-ipc";
import { applicationStateSchema, attachmentSchema, thinkingLevelSchema, windowViewStateSchema } from "./session-contract";

export const desktopEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("agent-state"), state: z.enum(["starting", "ready", "stopped", "failed"]), workspacePath: z.string().max(4_096).optional() }),
  ...agentEventSchema.options.filter((schema) => schema.shape.type.value !== "ready"),
  z.object({ type: z.literal("agent-error"), requestId: z.uuid().optional(), message: z.string().max(2_048) })
]);

export const desktopRequestSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("choose-project") }),
  z.object({ type: z.literal("get-home-directory") }),
  z.object({ type: z.literal("choose-attachments") }),
  z.object({ type: z.literal("load-window-state") }),
  z.object({ type: z.literal("save-window-state"), state: windowViewStateSchema }),
  z.object({ type: z.literal("load-application-state") }),
  z.object({ type: z.literal("register-project"), path: z.string().max(4_096), name: z.string().min(1).max(512) }),
  z.object({ type: z.literal("rename-project"), path: z.string().max(4_096), name: z.string().min(1).max(512) }),
  z.object({ type: z.literal("remove-project"), path: z.string().max(4_096) }),
  z.object({ type: z.literal("archive-session"), path: z.string().max(4_096), sessionId: z.string().max(256), archived: z.boolean() }),
  z.object({ type: z.literal("new-window") }),
  z.object({ type: z.literal("restart-agent"), path: z.string().max(4_096) }),
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
  z.object({ type: z.literal("prompt"), requestId: z.uuid(), text: z.string().min(1).max(262_144), delivery: z.enum(["prompt", "steer", "follow-up"]), attachments: z.array(attachmentSchema).max(20), workspacePath: z.string().max(4_096), sessionId: z.string().max(256) }),
  z.object({ type: z.literal("abort"), requestId: z.uuid(), workspacePath: z.string().max(4_096), sessionId: z.string().max(256) }),
  z.object({ type: z.literal("set-model"), requestId: z.uuid(), provider: z.string(), modelId: z.string(), workspacePath: z.string().max(4_096), sessionId: z.string().max(256) }),
  z.object({ type: z.literal("set-thinking"), requestId: z.uuid(), level: thinkingLevelSchema, workspacePath: z.string().max(4_096), sessionId: z.string().max(256) }),
  z.object({ type: z.literal("login"), requestId: z.uuid(), provider: z.string(), authType: z.enum(["api_key", "oauth"]), workspacePath: z.string().max(4_096), sessionId: z.string().max(256) }),
  z.object({ type: z.literal("logout"), requestId: z.uuid(), provider: z.string(), workspacePath: z.string().max(4_096), sessionId: z.string().max(256) }),
  z.object({ type: z.literal("rename-session"), requestId: z.uuid(), workspacePath: z.string().max(4_096), sessionId: z.string().max(256), name: z.string().min(1).max(512) }),
  z.object({ type: z.literal("fork-session"), requestId: z.uuid(), workspacePath: z.string().max(4_096), sessionId: z.string().max(256), entryId: z.string().max(256) }),
  z.object({ type: z.literal("navigate-session"), requestId: z.uuid(), workspacePath: z.string().max(4_096), sessionId: z.string().max(256), entryId: z.string().max(256) }),
  z.object({ type: z.literal("inspect-changes"), requestId: z.uuid(), workspacePath: z.string().max(4_096) }),
  z.object({ type: z.literal("terminal-start"), requestId: z.uuid(), workspacePath: z.string().max(4_096), terminalId: z.string().max(256), cols: z.number().int().min(20).max(500), rows: z.number().int().min(5).max(200) }),
  z.object({ type: z.literal("terminal-input"), requestId: z.uuid(), workspacePath: z.string().max(4_096), terminalId: z.string().max(256), data: z.string().max(65_536) }),
  z.object({ type: z.literal("terminal-resize"), requestId: z.uuid(), workspacePath: z.string().max(4_096), terminalId: z.string().max(256), cols: z.number().int().min(20).max(500), rows: z.number().int().min(5).max(200) }),
  z.object({ type: z.literal("terminal-close"), requestId: z.uuid(), workspacePath: z.string().max(4_096), terminalId: z.string().max(256) }),
  z.object({
    type: z.literal("respond-ui"),
    requestId: z.uuid(),
    uiRequestId: z.uuid(),
    value: z.string().max(262_144).optional(),
    cancelled: z.boolean(), workspacePath: z.string().max(4_096), sessionId: z.string().max(256)
  })
]);

export const desktopResponseSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("project-chosen"), path: z.string().max(4_096).optional() }),
  z.object({ type: z.literal("home-directory"), path: z.string().max(4_096) }),
  z.object({ type: z.literal("attachments-chosen"), attachments: z.array(attachmentSchema).max(20) }),
  z.object({ type: z.literal("window-state-loaded"), state: windowViewStateSchema }),
  z.object({ type: z.literal("window-state-saved") }),
  z.object({ type: z.literal("application-state-loaded"), state: applicationStateSchema }),
  z.object({ type: z.literal("application-state-updated"), state: applicationStateSchema }),
  z.object({ type: z.literal("window-created") }),
  z.object({ type: z.literal("accepted"), requestId: z.uuid() }),
  z.object({ type: z.literal("ui-response-accepted"), uiRequestId: z.uuid() })
]);

export type DesktopEvent = z.infer<typeof desktopEventSchema>;
export type DesktopRequest = z.infer<typeof desktopRequestSchema>;
export type DesktopResponse = z.infer<typeof desktopResponseSchema>;
export type AgentState = Extract<DesktopEvent, { type: "agent-state" }>["state"];

export interface CakeDesktopBridge {
  request(input: DesktopRequest): Promise<DesktopResponse>;
  subscribe(listener: (event: DesktopEvent) => void): () => void;
}
