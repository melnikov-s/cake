import { z } from "zod";
import { agentEventSchema } from "./agent-ipc";
import { attachmentSchema, thinkingLevelSchema, windowViewStateSchema } from "./session-contract";

export const desktopEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("agent-state"), state: z.enum(["starting", "ready", "stopped", "failed"]) }),
  ...agentEventSchema.options.filter((schema) => schema.shape.type.value !== "ready"),
  z.object({ type: z.literal("agent-error"), requestId: z.uuid().optional(), message: z.string().max(2_048) })
]);

export const desktopRequestSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("choose-project") }),
  z.object({ type: z.literal("get-home-directory") }),
  z.object({ type: z.literal("choose-attachments") }),
  z.object({ type: z.literal("load-window-state") }),
  z.object({ type: z.literal("save-window-state"), state: windowViewStateSchema }),
  z.object({ type: z.literal("inspect-workspace"), requestId: z.uuid(), path: z.string().max(4_096) }),
  z.object({
    type: z.literal("open-workspace"),
    requestId: z.uuid(),
    path: z.string().max(4_096),
    trusted: z.boolean(),
    newSession: z.boolean().default(false),
    sessionId: z.string().min(1).max(256).optional()
  }),
  z.object({ type: z.literal("prompt"), requestId: z.uuid(), text: z.string().min(1).max(262_144), delivery: z.enum(["prompt", "steer", "follow-up"]), attachments: z.array(attachmentSchema).max(20) }),
  z.object({ type: z.literal("abort"), requestId: z.uuid() }),
  z.object({ type: z.literal("set-model"), requestId: z.uuid(), provider: z.string(), modelId: z.string() }),
  z.object({ type: z.literal("set-thinking"), requestId: z.uuid(), level: thinkingLevelSchema }),
  z.object({ type: z.literal("login"), requestId: z.uuid(), provider: z.string(), authType: z.enum(["api_key", "oauth"]) }),
  z.object({ type: z.literal("logout"), requestId: z.uuid(), provider: z.string() }),
  z.object({
    type: z.literal("respond-ui"),
    requestId: z.uuid(),
    uiRequestId: z.uuid(),
    value: z.string().max(262_144).optional(),
    cancelled: z.boolean()
  })
]);

export const desktopResponseSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("project-chosen"), path: z.string().max(4_096).optional() }),
  z.object({ type: z.literal("home-directory"), path: z.string().max(4_096) }),
  z.object({ type: z.literal("attachments-chosen"), attachments: z.array(attachmentSchema).max(20) }),
  z.object({ type: z.literal("window-state-loaded"), state: windowViewStateSchema }),
  z.object({ type: z.literal("window-state-saved") }),
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
