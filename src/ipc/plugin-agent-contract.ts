import { Effect, Schema } from "effect";
import { ipcProjectionArray, ipcProjectionString } from "./projection";
import { sessionUsageSchema, thinkingLevelSchema, uiPartSchema } from "./session-contract";

export const PLUGIN_COMPLETION_INPUT_MAX = 262_144;
const PLUGIN_COMPLETION_OUTPUT_MAX = 32_768;
const bounded = (minimum: number, maximum: number) =>
  Schema.String.check(Schema.isMinLength(minimum), Schema.isMaxLength(maximum));
const defaultKey = <S extends Schema.Top>(schema: S, value: S["Type"]) =>
  schema.pipe(Schema.withDecodingDefaultKey(Effect.succeed(value)));

const workspaceRefSchema = Schema.Struct({
  kind: Schema.Literal("cake.workspace-ref"),
  id: bounded(1, 8_192),
});
export const sessionRefSchema = Schema.Struct({
  kind: Schema.Literal("cake.session-ref"),
  id: bounded(1, 8_192),
});
const visibilitySchema = Schema.Literals(["private", "project"]);
const agentSessionTargetSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("new"),
    workspace: Schema.optional(workspaceRefSchema),
    visibility: defaultKey(visibilitySchema, "private"),
  }),
  Schema.Struct({ kind: Schema.Literal("attach"), target: Schema.optional(sessionRefSchema) }),
  Schema.Struct({
    kind: Schema.Literal("fork"),
    source: Schema.optional(sessionRefSchema),
    entryId: Schema.optional(bounded(1, 256)),
    visibility: defaultKey(visibilitySchema, "private"),
  }),
]);

export const agentModelPreferenceSchema = Schema.Union([
  Schema.Struct({ prefer: Schema.Literal("utility") }),
  Schema.Struct({ prefer: Schema.Literal("default") }),
  Schema.Struct({ prefer: Schema.Literal("current") }),
  Schema.Struct({
    prefer: Schema.Literal("exact"),
    provider: bounded(1, 256),
    modelId: bounded(1, 512),
    thinkingLevel: Schema.optional(thinkingLevelSchema),
  }),
]);
export const resolvedAgentModelSchema = Schema.Struct({
  requested: Schema.Literals(["utility", "default", "current", "exact"]),
  source: Schema.Literals(["utility", "default", "current", "exact"]),
  provider: bounded(1, 256),
  modelId: bounded(1, 512),
  thinkingLevel: thinkingLevelSchema,
  fallbacks: Schema.Array(
    Schema.Struct({
      source: Schema.Literals(["utility", "default", "current"]),
      reason: Schema.Literals(["not-configured", "unknown-model", "not-authenticated"]),
    }),
  ).check(Schema.isMaxLength(3)),
});
export const pluginAgentOpenOptionsSchema = Schema.Struct({
  session: agentSessionTargetSchema,
  model: defaultKey(agentModelPreferenceSchema, { prefer: "current" }),
  instructions: Schema.optional(ipcProjectionString(32_768)),
});
const sessionContextSelectionSchema = Schema.Union([
  Schema.Literals(["last-message", "last-user-message", "last-assistant-message"]),
  Schema.Struct({
    kind: Schema.Literal("recent-messages"),
    count: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })),
  }),
  Schema.Struct({
    kind: Schema.Literal("current-branch"),
    maximumInputCharacters: Schema.Int.check(
      Schema.isBetween({ minimum: 1, maximum: PLUGIN_COMPLETION_INPUT_MAX }),
    ),
  }),
]);
export const pluginCompletionRequestSchema = Schema.Struct({
  model: defaultKey(agentModelPreferenceSchema, { prefer: "utility" }),
  context: Schema.Struct({
    kind: Schema.Literal("session"),
    target: Schema.optional(sessionRefSchema),
    selection: sessionContextSelectionSchema,
  }),
  instructions: ipcProjectionString(32_768).check(Schema.isMinLength(1)),
  maximumOutputCharacters: defaultKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: PLUGIN_COMPLETION_OUTPUT_MAX })),
    8_192,
  ),
});
const pluginSessionActivitySchema = Schema.Struct({
  streaming: Schema.Boolean,
  settledRevision: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  leafId: Schema.optional(bounded(1, 256)),
  lastMessageId: Schema.optional(bounded(1, 256)),
});
export const pluginAgentSnapshotSchema = Schema.Struct({
  handleId: Schema.String.check(Schema.isUUID()),
  ref: sessionRefSchema,
  workspace: workspaceRefSchema,
  resolvedModel: resolvedAgentModelSchema,
  status: Schema.Literals(["idle", "running", "error"]),
  parts: ipcProjectionArray(uiPartSchema, 50_000),
  usage: Schema.optional(sessionUsageSchema),
  activity: pluginSessionActivitySchema,
  error: Schema.optional(ipcProjectionString(32_768)),
});
export const pluginCompletionResultSchema = Schema.Struct({
  text: ipcProjectionString(PLUGIN_COMPLETION_OUTPUT_MAX),
  resolvedModel: resolvedAgentModelSchema,
  sourceRevision: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
});

export type WorkspaceRef = typeof workspaceRefSchema.Type;
export type SessionRef = typeof sessionRefSchema.Type;
export type AgentSessionTarget = typeof agentSessionTargetSchema.Type;
export type AgentModelPreference = typeof agentModelPreferenceSchema.Type;
export type ResolvedAgentModel = typeof resolvedAgentModelSchema.Type;
export type PluginAgentOpenOptions = typeof pluginAgentOpenOptionsSchema.Type;
export type SessionContextSelection = typeof sessionContextSelectionSchema.Type;
export type PluginCompletionRequest = typeof pluginCompletionRequestSchema.Type;
export type PluginSessionActivity = typeof pluginSessionActivitySchema.Type;
export type PluginAgentSnapshot = typeof pluginAgentSnapshotSchema.Type;
export type PluginCompletionResult = typeof pluginCompletionResultSchema.Type;
