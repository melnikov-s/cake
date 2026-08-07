import { z } from "zod";

export const agentCommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("start"), requestId: z.uuid() }),
  z.object({
    type: z.literal("ui-response"),
    requestId: z.uuid(),
    uiRequestId: z.uuid(),
    accepted: z.boolean()
  }),
  z.object({ type: z.literal("shutdown") })
]);

export const agentEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready") }),
  z.object({
    type: z.literal("text-delta"),
    requestId: z.uuid(),
    text: z.string().max(16_384)
  }),
  z.object({
    type: z.literal("ui-request"),
    requestId: z.uuid(),
    uiRequestId: z.uuid(),
    kind: z.literal("confirm"),
    title: z.string().max(256),
    message: z.string().max(2_048)
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
