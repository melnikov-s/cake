import { z } from "zod";
import { artifactRecordSchema } from "./artifact-contract";
import { reviewAnchorSchema, reviewThreadSchema } from "./review-contract";
import { ipcProjectionArray, ipcProjectionString } from "./projection";
import { customizationStateSchema, pluginDiagnosticSchema, pluginIdSchema, pluginPersistenceKeySchema, pluginPersistenceRecordSchema, pluginPersistenceScopeSchema, pluginStatusSchema } from "../plugin/plugin-contract";
import { compiledInlineWidgetSchema, inlineWidgetCapabilitySchema, inlineWidgetLanguageSchema, inlineWidgetSourceSchema, repairedInlineWidgetSchema } from "./inline-widget-contract";
import { jsonObjectSchema, jsonValueSchema } from "./json-contract";
import {
  applicationStateSchema,
  attachmentSchema,
  changedFileSchema,
  extensionUiEventSchema,
  fileSuggestionSchema,
  globalSessionSummarySchema,
  piSettingUpdateSchema,
  sessionPreviewSchema,
  sessionSnapshotSchema,
  thinkingLevelSchema,
  uiPartSchema,
  windowViewStateSchema
} from "./session-contract";

export const desktopEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("pi-state"), state: z.enum(["starting", "ready", "stopped", "failed"]), workspacePath: z.string().max(4_096).optional() }),
  z.object({ type: z.literal("workspace-inspected"), requestId: z.uuid(), path: z.string().max(4_096), trustRequired: z.boolean() }),
  z.object({ type: z.literal("session-snapshot"), requestId: z.uuid().optional(), snapshot: sessionSnapshotSchema }),
  z.object({ type: z.literal("part-updated"), sessionId: z.string(), part: uiPartSchema }),
  z.object({ type: z.literal("part-removed"), sessionId: z.string(), partId: z.string().max(256) }),
  z.object({ type: z.literal("session-streaming"), sessionId: z.string(), streaming: z.boolean() }),
  z.object({ type: z.literal("global-chat-snapshot"), requestId: z.uuid().optional(), snapshot: sessionSnapshotSchema }),
  z.object({ type: z.literal("global-chat-part-updated"), sessionId: z.string().min(1).max(256), part: uiPartSchema }),
  z.object({ type: z.literal("global-chat-part-removed"), sessionId: z.string().min(1).max(256), partId: z.string().max(256) }),
  z.object({ type: z.literal("global-chat-streaming"), sessionId: z.string().min(1).max(256), streaming: z.boolean() }),
  z.object({ type: z.literal("global-chat-operation-completed"), requestId: z.uuid() }),
  z.object({ type: z.literal("global-chat-operation-failed"), requestId: z.uuid(), message: ipcProjectionString(2_048) }),
  z.object({ type: z.literal("global-chat-control-request"), controlRequestId: z.uuid(), invocation: z.object({ name: z.string().min(1).max(256), arguments: jsonValueSchema }) }),
  z.object({ type: z.literal("extension-ui"), sessionId: z.string().max(256), event: extensionUiEventSchema }),
  z.object({ type: z.literal("changes-snapshot"), requestId: z.uuid(), workspacePath: z.string().max(4_096), sessionId: z.string().max(256), files: ipcProjectionArray(changedFileSchema, 10_000) }),
  z.object({ type: z.literal("changelog-snapshot"), requestId: z.uuid(), workspacePath: z.string().max(4_096), sessionId: z.string().max(256), markdown: ipcProjectionString(1_000_000) }),
  z.object({ type: z.literal("artifact-updated"), record: artifactRecordSchema }),
  z.object({ type: z.literal("artifact-requested"), requestId: z.uuid(), artifactRequestId: z.uuid(), record: artifactRecordSchema }),
  z.object({ type: z.literal("review-threads-snapshot"), workspacePath: z.string().max(4_096), sessionId: z.string().max(256), threads: ipcProjectionArray(reviewThreadSchema, 10_000) }),
  z.object({ type: z.literal("review-thread-updated"), thread: reviewThreadSchema }),
  z.object({ type: z.literal("review-thread-streaming"), workspacePath: z.string().max(4_096), sessionId: z.string().max(256), threadId: z.string().max(256), streaming: z.boolean() }),
  z.object({
    type: z.literal("ui-request"),
    requestId: z.uuid(),
    uiRequestId: z.uuid(),
    kind: z.enum(["confirm", "text", "secret", "select", "manual_code", "editor"]),
    title: ipcProjectionString(512),
    message: ipcProjectionString(4_096),
    placeholder: ipcProjectionString(512).optional(),
    initialValue: ipcProjectionString(262_144).optional(),
    multiline: z.boolean().optional(),
    options: ipcProjectionArray(z.object({ id: ipcProjectionString(256), label: ipcProjectionString(512) }), 100).optional()
  }),
  z.object({ type: z.literal("complete"), requestId: z.uuid() }),
  z.object({ type: z.literal("fatal"), requestId: z.uuid().optional(), message: ipcProjectionString(2_048) })
  ,z.object({ type: z.literal("customization-state-changed"), state: customizationStateSchema })
]);

export const desktopRequestSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("choose-project") }),
  z.object({ type: z.literal("get-home-directory") }),
  z.object({ type: z.literal("get-customization-state") }),
  z.object({ type: z.literal("build-customization"), expectedBaseRevision: z.string().regex(/^[a-f0-9]{64}$/).optional(), expectedSourceRevision: z.string().regex(/^[a-f0-9]{64}$/).optional(), request: ipcProjectionString(8_192).optional() }),
  z.object({ type: z.literal("list-customization-files") }),
  z.object({ type: z.literal("read-customization-file"), path: z.string().min(1).max(8_192) }),
  z.object({ type: z.literal("write-customization-file"), path: z.string().min(1).max(8_192), content: z.string().max(2_000_000), expectedWorkingRevision: z.string().regex(/^[a-f0-9]{64}$/) }),
  z.object({ type: z.literal("customization-rendered"), revision: z.string().regex(/^[a-f0-9]{64}$/) }),
  z.object({ type: z.literal("customization-runtime-failed"), revision: z.string().regex(/^[a-f0-9]{64}$/).optional(), message: ipcProjectionString(32_768) }),
  z.object({ type: z.literal("rollback-customization") }),
  z.object({ type: z.literal("use-factory-customization") }),
  z.object({ type: z.literal("list-plugins") }),
  z.object({ type: z.literal("set-plugin-enabled"), pluginId: pluginIdSchema, enabled: z.boolean() }),
  z.object({ type: z.literal("delete-plugin"), pluginId: pluginIdSchema }),
  z.object({ type: z.literal("load-plugin-state"), pluginId: pluginIdSchema, key: pluginPersistenceKeySchema, scope: pluginPersistenceScopeSchema }),
  z.object({ type: z.literal("save-plugin-state"), pluginId: pluginIdSchema, key: pluginPersistenceKeySchema, scope: pluginPersistenceScopeSchema, value: z.json(), expectedVersion: z.number().int().nonnegative().optional() }),
  z.object({ type: z.literal("choose-attachments") }),
  z.object({ type: z.literal("suggest-files"), workspacePath: z.string().max(4_096), prefix: z.string().max(4_096) }),
  z.object({ type: z.literal("list-workspace-files"), workspacePath: z.string().max(4_096) }),
  z.object({ type: z.literal("read-workspace-file"), workspacePath: z.string().max(4_096), path: z.string().min(1).max(8_192) }),
  z.object({ type: z.literal("compile-inline-widget"), language: inlineWidgetLanguageSchema, capability: inlineWidgetCapabilitySchema, source: inlineWidgetSourceSchema }),
  z.object({ type: z.literal("repair-inline-widget"), workspacePath: z.string().max(4_096), sessionId: z.string().min(1).max(256), language: inlineWidgetLanguageSchema, capability: inlineWidgetCapabilitySchema, source: inlineWidgetSourceSchema, context: z.string().max(262_144), diagnostic: z.string().max(32_768).optional(), model: z.object({ provider: z.string().min(1).max(256), id: z.string().min(1).max(512) }).optional() }),
  z.object({ type: z.literal("load-window-state") }),
  z.object({ type: z.literal("save-window-state"), state: windowViewStateSchema }),
  z.object({ type: z.literal("load-application-state") }),
  z.object({ type: z.literal("list-sessions") }),
  z.object({ type: z.literal("load-session"), workspacePath: z.string().max(4_096), sessionId: z.string().min(1).max(256) }),
  z.object({ type: z.literal("open-global-chat"), requestId: z.uuid(), tools: z.array(z.object({ name: z.string().min(1).max(256), description: z.string().min(1).max(2_048), parameters: jsonObjectSchema })).min(1).max(50), newSession: z.boolean().default(false), sessionId: z.string().min(1).max(256).optional(), initialPrompt: z.string().min(1).max(262_144).optional() }),
  z.object({ type: z.literal("prompt-global-chat"), requestId: z.uuid(), sessionId: z.string().min(1).max(256), text: z.string().max(262_144), attachments: z.array(attachmentSchema).max(20) })
    .refine((request) => Boolean(request.text.trim() || request.attachments.length), { message: "A global-chat prompt requires text or an attachment" }),
  z.object({ type: z.literal("abort-global-chat"), requestId: z.uuid(), sessionId: z.string().min(1).max(256) }),
  z.object({ type: z.literal("set-global-chat-model"), requestId: z.uuid(), sessionId: z.string().min(1).max(256), provider: z.string().min(1).max(256), modelId: z.string().min(1).max(512) }),
  z.object({ type: z.literal("set-global-chat-thinking"), requestId: z.uuid(), sessionId: z.string().min(1).max(256), level: thinkingLevelSchema }),
  z.object({ type: z.literal("respond-global-chat-control"), controlRequestId: z.uuid(), result: jsonValueSchema }),
  z.object({ type: z.literal("list-review-threads"), workspacePath: z.string().max(4_096), sessionId: z.string().min(1).max(256) }),
  z.object({ type: z.literal("create-review-thread"), workspacePath: z.string().max(4_096), sessionId: z.string().min(1).max(256), anchor: reviewAnchorSchema, body: z.string().min(1).max(262_144) }),
  z.object({ type: z.literal("reply-review-thread"), workspacePath: z.string().max(4_096), sessionId: z.string().min(1).max(256), threadId: z.string().min(1).max(256), body: z.string().min(1).max(262_144) }),
  z.object({ type: z.literal("resolve-review-thread"), workspacePath: z.string().max(4_096), sessionId: z.string().min(1).max(256), threadId: z.string().min(1).max(256), resolved: z.boolean() }),
  z.object({ type: z.literal("register-project"), path: z.string().max(4_096), name: z.string().min(1).max(512) }),
  z.object({ type: z.literal("rename-project"), path: z.string().max(4_096), name: z.string().min(1).max(512) }),
  z.object({ type: z.literal("remove-project"), path: z.string().max(4_096) }),
  z.object({ type: z.literal("archive-session"), path: z.string().max(4_096), sessionId: z.string().max(256), archived: z.boolean() }),
  z.object({ type: z.literal("new-window") }),
  z.object({ type: z.literal("restart-pi"), path: z.string().max(4_096) }),
  z.object({ type: z.literal("inspect-workspace"), requestId: z.uuid(), path: z.string().max(4_096) }),
  z.object({ type: z.literal("respond-workspace-trust"), requestId: z.uuid(), path: z.string().max(4_096), approved: z.boolean() }),
  z.object({
    type: z.literal("open-workspace"),
    requestId: z.uuid(),
    path: z.string().max(4_096),
    newSession: z.boolean().default(false),
    sessionId: z.string().min(1).max(256).optional()
  }),
  z.object({ type: z.literal("prompt"), requestId: z.uuid(), text: z.string().max(262_144), delivery: z.enum(["prompt", "steer", "follow-up"]), attachments: z.array(attachmentSchema).max(20), workspacePath: z.string().max(4_096), sessionId: z.string().max(256) }).refine((request) => Boolean(request.text.trim() || request.attachments.length), { message: "A prompt requires text or an attachment" }),
  z.object({ type: z.literal("submit-review-threads"), requestId: z.uuid(), workspacePath: z.string().max(4_096), sessionId: z.string().max(256), threadIds: z.array(z.string().min(1).max(256)).min(1).max(100), commentCount: z.number().int().positive().max(1_000_000), instruction: z.string().max(262_144).optional(), model: z.object({ provider: z.string().max(256), id: z.string().max(512) }).optional(), thinkingLevel: thinkingLevelSchema.optional() }),
  z.object({ type: z.literal("abort"), requestId: z.uuid(), workspacePath: z.string().max(4_096), sessionId: z.string().max(256) }),
  z.object({ type: z.literal("set-model"), requestId: z.uuid(), provider: z.string(), modelId: z.string(), workspacePath: z.string().max(4_096), sessionId: z.string().max(256) }),
  z.object({ type: z.literal("set-thinking"), requestId: z.uuid(), level: thinkingLevelSchema, workspacePath: z.string().max(4_096), sessionId: z.string().max(256) }),
  z.object({ type: z.literal("set-pi-setting"), requestId: z.uuid(), update: piSettingUpdateSchema, workspacePath: z.string().max(4_096), sessionId: z.string().max(256) }),
  z.object({ type: z.literal("reload-pi"), requestId: z.uuid(), workspacePath: z.string().max(4_096), sessionId: z.string().max(256) }),
  z.object({ type: z.literal("login"), requestId: z.uuid(), provider: z.string(), authType: z.enum(["api_key", "oauth"]), workspacePath: z.string().max(4_096), sessionId: z.string().max(256) }),
  z.object({ type: z.literal("logout"), requestId: z.uuid(), provider: z.string(), workspacePath: z.string().max(4_096), sessionId: z.string().max(256) }),
  z.object({ type: z.literal("rename-session"), requestId: z.uuid(), workspacePath: z.string().max(4_096), sessionId: z.string().max(256), name: z.string().min(1).max(512) }),
  z.object({ type: z.literal("fork-session"), requestId: z.uuid(), workspacePath: z.string().max(4_096), sessionId: z.string().max(256), entryId: z.string().max(256) }),
  z.object({ type: z.literal("navigate-session"), requestId: z.uuid(), workspacePath: z.string().max(4_096), sessionId: z.string().max(256), entryId: z.string().max(256) }),
  z.object({ type: z.literal("inspect-changes"), requestId: z.uuid(), workspacePath: z.string().max(4_096), sessionId: z.string().max(256) }),
  z.object({ type: z.literal("get-changelog"), requestId: z.uuid(), workspacePath: z.string().max(4_096), sessionId: z.string().max(256) }),
  z.object({ type: z.literal("respond-artifact"), requestId: z.uuid(), artifactRequestId: z.uuid(), workspacePath: z.string().max(4_096), sessionId: z.string().max(256), value: jsonValueSchema.optional(), cancelled: z.boolean() }),
  z.object({ type: z.literal("export-artifacts"), workspacePath: z.string().max(4_096), sessionId: z.string().max(256) }),
  z.object({
    type: z.literal("respond-ui"),
    requestId: z.uuid(),
    uiRequestId: z.uuid(),
    value: z.string().max(262_144).optional(),
    cancelled: z.boolean(), workspacePath: z.string().max(4_096), sessionId: z.string().max(256)
  })
]);

export const desktopResponseSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("project-chosen"), path: z.string().max(4_096).optional() }),
  z.object({ type: z.literal("home-directory"), path: z.string().max(4_096) }),
  z.object({ type: z.literal("customization-state"), state: customizationStateSchema }),
  z.object({ type: z.literal("customization-build"), revision: z.string().regex(/^[a-f0-9]{64}$/), diagnostics: z.array(pluginDiagnosticSchema).max(1_000), activating: z.boolean() }),
  z.object({ type: z.literal("customization-files"), workingRevision: z.string().regex(/^[a-f0-9]{64}$/), buildRevision: z.string().regex(/^[a-f0-9]{64}$/), files: z.array(z.string().min(1).max(8_192)).max(100_000) }),
  z.object({ type: z.literal("customization-file"), path: z.string().min(1).max(8_192), content: z.string().max(2_000_000) }),
  z.object({ type: z.literal("plugin-state"), record: pluginPersistenceRecordSchema.optional() }),
  z.object({ type: z.literal("plugins-listed"), plugins: z.array(pluginStatusSchema).max(1_000) }),
  z.object({ type: z.literal("attachments-chosen"), attachments: z.array(attachmentSchema).max(20) }),
  z.object({ type: z.literal("file-suggestions"), suggestions: z.array(fileSuggestionSchema).max(20) }),
  z.object({ type: z.literal("workspace-files"), files: z.array(z.string().min(1).max(8_192)).max(50_000) }),
  z.object({ type: z.literal("workspace-file"), content: z.string().max(2_000_000) }),
  z.object({ type: z.literal("inline-widget-compiled"), widget: compiledInlineWidgetSchema }),
  z.object({ type: z.literal("inline-widget-repaired"), widget: repairedInlineWidgetSchema }),
  z.object({ type: z.literal("window-state-loaded"), state: windowViewStateSchema }),
  z.object({ type: z.literal("window-state-saved") }),
  z.object({ type: z.literal("application-state-loaded"), state: applicationStateSchema }),
  z.object({ type: z.literal("sessions-listed"), sessions: ipcProjectionArray(globalSessionSummarySchema, 50_000), reviewThreads: ipcProjectionArray(reviewThreadSchema, 100_000) }),
  z.object({ type: z.literal("session-loaded"), session: sessionPreviewSchema.optional() }),
  z.object({ type: z.literal("review-threads-loaded"), threads: ipcProjectionArray(reviewThreadSchema, 10_000) }),
  z.object({ type: z.literal("review-thread-saved"), thread: reviewThreadSchema }),
  z.object({ type: z.literal("application-state-updated"), state: applicationStateSchema }),
  z.object({ type: z.literal("window-created") }),
  z.object({ type: z.literal("accepted"), requestId: z.uuid() }),
  z.object({ type: z.literal("ui-response-accepted"), uiRequestId: z.uuid() })
  ,z.object({ type: z.literal("artifact-response-accepted"), artifactRequestId: z.uuid() })
  ,z.object({ type: z.literal("artifacts-exported"), markdown: z.string().max(20_000_000) })
]);

export type DesktopEvent = z.infer<typeof desktopEventSchema>;
export type DesktopRequest = z.infer<typeof desktopRequestSchema>;
export type DesktopResponse = z.infer<typeof desktopResponseSchema>;
export type PiState = Extract<DesktopEvent, { type: "pi-state" }>["state"];

export interface CakeDesktopBridge {
  request(input: DesktopRequest): Promise<DesktopResponse>;
  subscribe(listener: (event: DesktopEvent) => void): () => void;
}
