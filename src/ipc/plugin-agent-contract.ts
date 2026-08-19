import { z } from "zod";
import { ipcProjectionArray, ipcProjectionString } from "./projection";
import { sessionUsageSchema, thinkingLevelSchema, uiPartSchema } from "./session-contract";

export const PLUGIN_AGENT_PROMPT_MAX = 262_144;
export const PLUGIN_COMPLETION_INPUT_MAX = 262_144;
export const PLUGIN_COMPLETION_OUTPUT_MAX = 32_768;

export const workspaceRefSchema = z.object({
  kind: z.literal("cake.workspace-ref"),
  id: z.string().min(1).max(8_192),
});

export const sessionRefSchema = z.object({
  kind: z.literal("cake.session-ref"),
  id: z.string().min(1).max(8_192),
});

export const agentSessionTargetSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("new"),
    workspace: workspaceRefSchema.optional(),
    visibility: z.enum(["private", "project"]).default("private"),
  }),
  z.object({ kind: z.literal("attach"), target: sessionRefSchema.optional() }),
  z.object({
    kind: z.literal("fork"),
    source: sessionRefSchema.optional(),
    entryId: z.string().min(1).max(256).optional(),
    visibility: z.enum(["private", "project"]).default("private"),
  }),
]);

export const agentModelPreferenceSchema = z.discriminatedUnion("prefer", [
  z.object({ prefer: z.literal("utility") }),
  z.object({ prefer: z.literal("default") }),
  z.object({ prefer: z.literal("current") }),
  z.object({
    prefer: z.literal("exact"),
    provider: z.string().min(1).max(256),
    modelId: z.string().min(1).max(512),
    thinkingLevel: thinkingLevelSchema.optional(),
  }),
]);

export const resolvedAgentModelSchema = z.object({
  requested: z.enum(["utility", "default", "current", "exact"]),
  source: z.enum(["utility", "default", "current", "exact"]),
  provider: z.string().min(1).max(256),
  modelId: z.string().min(1).max(512),
  thinkingLevel: thinkingLevelSchema,
  fallbacks: z
    .array(
      z.object({
        source: z.enum(["utility", "default", "current"]),
        reason: z.enum(["not-configured", "unknown-model", "not-authenticated"]),
      }),
    )
    .max(3),
});

export const pluginAgentOpenOptionsSchema = z.object({
  session: agentSessionTargetSchema,
  model: agentModelPreferenceSchema.default({ prefer: "current" }),
  instructions: ipcProjectionString(32_768).optional(),
});

export const sessionContextSelectionSchema = z.union([
  z.enum(["last-message", "last-user-message", "last-assistant-message"]),
  z.object({ kind: z.literal("recent-messages"), count: z.number().int().min(1).max(100) }),
  z.object({
    kind: z.literal("current-branch"),
    maximumInputCharacters: z.number().int().min(1).max(PLUGIN_COMPLETION_INPUT_MAX),
  }),
]);

export const pluginCompletionRequestSchema = z.object({
  model: agentModelPreferenceSchema.default({ prefer: "utility" }),
  context: z.object({
    kind: z.literal("session"),
    target: sessionRefSchema.optional(),
    selection: sessionContextSelectionSchema,
  }),
  instructions: ipcProjectionString(32_768).pipe(z.string().min(1)),
  maximumOutputCharacters: z.number().int().min(1).max(PLUGIN_COMPLETION_OUTPUT_MAX).default(8_192),
});

export const pluginSessionActivitySchema = z.object({
  streaming: z.boolean(),
  settledRevision: z.string().regex(/^[a-f0-9]{64}$/),
  leafId: z.string().min(1).max(256).optional(),
  lastMessageId: z.string().min(1).max(256).optional(),
});

export const pluginAgentSnapshotSchema = z.object({
  handleId: z.uuid(),
  ref: sessionRefSchema,
  workspace: workspaceRefSchema,
  resolvedModel: resolvedAgentModelSchema,
  status: z.enum(["idle", "running", "error"]),
  parts: ipcProjectionArray(uiPartSchema, 50_000),
  usage: sessionUsageSchema.optional(),
  activity: pluginSessionActivitySchema,
  error: ipcProjectionString(32_768).optional(),
});

export const pluginCompletionResultSchema = z.object({
  text: ipcProjectionString(PLUGIN_COMPLETION_OUTPUT_MAX),
  resolvedModel: resolvedAgentModelSchema,
  sourceRevision: z.string().regex(/^[a-f0-9]{64}$/),
});

export type WorkspaceRef = z.infer<typeof workspaceRefSchema>;
export type SessionRef = z.infer<typeof sessionRefSchema>;
export type AgentSessionTarget = z.infer<typeof agentSessionTargetSchema>;
export type AgentModelPreference = z.infer<typeof agentModelPreferenceSchema>;
export type ResolvedAgentModel = z.infer<typeof resolvedAgentModelSchema>;
export type PluginAgentOpenOptions = z.infer<typeof pluginAgentOpenOptionsSchema>;
export type SessionContextSelection = z.infer<typeof sessionContextSelectionSchema>;
export type PluginCompletionRequest = z.infer<typeof pluginCompletionRequestSchema>;
export type PluginSessionActivity = z.infer<typeof pluginSessionActivitySchema>;
export type PluginAgentSnapshot = z.infer<typeof pluginAgentSnapshotSchema>;
export type PluginCompletionResult = z.infer<typeof pluginCompletionResultSchema>;
