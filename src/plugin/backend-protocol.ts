import { z } from "zod";
import { jsonValueSchema } from "../ipc/json-contract";
import { pluginIdSchema } from "./plugin-contract";

export const pluginBackendHostRequestSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("init"), pluginId: pluginIdSchema, backendPath: z.string().min(1) }),
  z.object({
    type: z.literal("call"),
    callId: z.uuid(),
    method: z.string().min(1).max(256),
    input: jsonValueSchema,
  }),
  z.object({ type: z.literal("cancel"), callId: z.uuid() }),
  z.object({ type: z.literal("dispose") }),
]);

export const pluginBackendHostMessageSchema = z.union([
  z.object({ type: z.literal("ready"), pluginId: pluginIdSchema }),
  z.object({
    type: z.literal("result"),
    callId: z.uuid(),
    ok: z.literal(true),
    value: jsonValueSchema,
  }),
  z.object({
    type: z.literal("result"),
    callId: z.uuid(),
    ok: z.literal(false),
    error: z.string().max(32_768),
  }),
  z.object({ type: z.literal("event"), name: z.string().min(1).max(256), value: jsonValueSchema }),
  z.object({ type: z.literal("fatal"), error: z.string().max(32_768) }),
]);

export type PluginBackendHostMessage = z.infer<typeof pluginBackendHostMessageSchema>;
