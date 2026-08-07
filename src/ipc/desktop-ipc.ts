import { z } from "zod";

export const desktopEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("agent-state"), state: z.enum(["starting", "ready", "stopped", "failed"]) }),
  z.object({ type: z.literal("text-delta"), requestId: z.uuid(), text: z.string().max(16_384) }),
  z.object({
    type: z.literal("ui-request"),
    requestId: z.uuid(),
    uiRequestId: z.uuid(),
    kind: z.literal("confirm"),
    title: z.string().max(256),
    message: z.string().max(2_048)
  }),
  z.object({ type: z.literal("complete"), requestId: z.uuid() }),
  z.object({ type: z.literal("agent-error"), requestId: z.uuid().optional(), message: z.string().max(2_048) })
]);

export const desktopRequestSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("start-foundation-check"), requestId: z.uuid() }),
  z.object({
    type: z.literal("respond-ui"),
    requestId: z.uuid(),
    uiRequestId: z.uuid(),
    accepted: z.boolean()
  })
]);

export const desktopResponseSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("started"), requestId: z.uuid() }),
  z.object({ type: z.literal("ui-response-accepted"), uiRequestId: z.uuid() })
]);

export type DesktopEvent = z.infer<typeof desktopEventSchema>;
export type DesktopRequest = z.infer<typeof desktopRequestSchema>;
export type DesktopResponse = z.infer<typeof desktopResponseSchema>;

export interface CakeDesktopBridge {
  request(input: DesktopRequest): Promise<DesktopResponse>;
  subscribe(listener: (event: DesktopEvent) => void): () => void;
}
