import { Schema } from "effect";

export const LocalMcpConfiguration = Schema.Struct({
  enabled: Schema.Boolean,
  port: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 65535 })),
});
export interface LocalMcpConfiguration extends Schema.Schema.Type<typeof LocalMcpConfiguration> {}
export const LocalMcpRuntime = Schema.Struct({
  status: Schema.Literals(["disabled", "serving", "error"]),
  url: Schema.optionalKey(Schema.String),
  error: Schema.optionalKey(Schema.String),
});
export interface LocalMcpRuntime extends Schema.Schema.Type<typeof LocalMcpRuntime> {}
export const LocalMcpSnapshot = Schema.Struct({
  configuration: LocalMcpConfiguration,
  runtime: LocalMcpRuntime,
  clientConfiguration: Schema.optionalKey(Schema.String),
});
export interface LocalMcpSnapshot extends Schema.Schema.Type<typeof LocalMcpSnapshot> {}
export const defaultLocalMcpConfiguration = (): LocalMcpConfiguration => ({
  enabled: false,
  port: 4318,
});
export class LocalMcpError extends Schema.TaggedError<LocalMcpError>()("LocalMcpError", {
  code: Schema.Literals(["invalid_input", "operation_failed"]),
  message: Schema.String,
}) {}
