import { Schema } from "effect";
import { jsonValueSchema } from "../ipc/json-contract";
import { pluginIdSchema } from "./plugin-contract";

const callId = Schema.String.check(Schema.isUUID());
export const pluginBackendHostRequestSchema = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("init"),
    pluginId: pluginIdSchema,
    backendPath: Schema.String.check(Schema.isMinLength(1)),
  }),
  Schema.Struct({
    type: Schema.Literal("call"),
    callId,
    method: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
    input: jsonValueSchema,
  }),
  Schema.Struct({ type: Schema.Literal("cancel"), callId }),
  Schema.Struct({ type: Schema.Literal("dispose") }),
]);
export const pluginBackendHostMessageSchema = Schema.Union([
  Schema.Struct({ type: Schema.Literal("ready"), pluginId: pluginIdSchema }),
  Schema.Struct({
    type: Schema.Literal("result"),
    callId,
    ok: Schema.Literal(true),
    value: jsonValueSchema,
  }),
  Schema.Struct({
    type: Schema.Literal("result"),
    callId,
    ok: Schema.Literal(false),
    error: Schema.String.check(Schema.isMaxLength(32_768)),
  }),
  Schema.Struct({
    type: Schema.Literal("event"),
    name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
    value: jsonValueSchema,
  }),
  Schema.Struct({
    type: Schema.Literal("fatal"),
    error: Schema.String.check(Schema.isMaxLength(32_768)),
  }),
]);
export type PluginBackendHostMessage = typeof pluginBackendHostMessageSchema.Type;
