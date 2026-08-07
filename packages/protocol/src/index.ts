import { z } from "zod";

export const workerCommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("start"), requestId: z.uuid() }),
  z.object({ type: z.literal("shutdown") })
]);

export const workerEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready") }),
  z.object({
    type: z.literal("text-delta"),
    requestId: z.uuid(),
    text: z.string().max(16_384)
  }),
  z.object({ type: z.literal("complete"), requestId: z.uuid() }),
  z.object({ type: z.literal("fatal"), message: z.string().max(2_048) })
]);

export const desktopEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("worker-state"), state: z.enum(["starting", "ready", "stopped", "failed"]) }),
  z.object({ type: z.literal("text-delta"), requestId: z.uuid(), text: z.string().max(16_384) })
]);

export const desktopRequestSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("start-demo") })
]);

export const desktopResponseSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("started"), requestId: z.uuid() })
]);

export type WorkerCommand = z.infer<typeof workerCommandSchema>;
export type WorkerEvent = z.infer<typeof workerEventSchema>;
export type DesktopEvent = z.infer<typeof desktopEventSchema>;
export type DesktopRequest = z.infer<typeof desktopRequestSchema>;
export type DesktopResponse = z.infer<typeof desktopResponseSchema>;

export interface CakeDesktopApi {
  request(input: DesktopRequest): Promise<DesktopResponse>;
  subscribe(listener: (event: DesktopEvent) => void): () => void;
}
