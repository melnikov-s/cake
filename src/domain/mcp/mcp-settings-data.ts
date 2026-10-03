import { Schema } from "effect";

export const McpScope = Schema.Struct({ projectPath: Schema.optionalKey(Schema.String) });
export interface McpScope extends Schema.Schema.Type<typeof McpScope> {}
export const McpEntry = Schema.Struct({
  name: Schema.String,
  scope: Schema.Literals(["backend", "project"]),
  source: Schema.String,
  overridden: Schema.Boolean,
  config: Schema.Record(Schema.String, Schema.Json),
});
export interface McpEntry extends Schema.Schema.Type<typeof McpEntry> {}
export const McpSettingsSnapshot = Schema.Struct({
  scope: McpScope,
  revision: Schema.String,
  entries: Schema.Array(McpEntry),
});
export interface McpSettingsSnapshot extends Schema.Schema.Type<typeof McpSettingsSnapshot> {}
export const McpSettingsRead = Schema.Struct({
  ...McpScope.fields,
  revealSecrets: Schema.optionalKey(Schema.Boolean),
});
export interface McpSettingsRead extends Schema.Schema.Type<typeof McpSettingsRead> {}
export const McpSettingsMutation = Schema.Struct({
  ...McpScope.fields,
  revision: Schema.String,
  name: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]+$/)),
  action: Schema.Literals(["save", "remove", "enable", "disable"]),
  config: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
});
export interface McpSettingsMutation extends Schema.Schema.Type<typeof McpSettingsMutation> {}
export class McpSettingsError extends Schema.TaggedError<McpSettingsError>()("McpSettingsError", {
  message: Schema.String,
}) {}
/** Sentinel is resolved only against the same field of an existing backend entry. */
export const MCP_STORED_SECRET = "•••• stored value ••••";
