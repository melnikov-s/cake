import { z } from "zod";
import { artifactRecordSchema } from "./artifact-contract";
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
  z.object({ type: z.literal("extension-ui"), sessionId: z.string().max(256), event: extensionUiEventSchema }),
  z.object({ type: z.literal("changes-snapshot"), requestId: z.uuid(), workspacePath: z.string().max(4_096), files: z.array(changedFileSchema).max(10_000) }),
  z.object({ type: z.literal("changelog-snapshot"), requestId: z.uuid(), workspacePath: z.string().max(4_096), sessionId: z.string().max(256), markdown: z.string().max(1_000_000) }),
  z.object({ type: z.literal("artifact-updated"), record: artifactRecordSchema }),
  z.object({ type: z.literal("artifact-requested"), requestId: z.uuid(), artifactRequestId: z.uuid(), record: artifactRecordSchema }),
  z.object({
    type: z.literal("ui-request"),
    requestId: z.uuid(),
    uiRequestId: z.uuid(),
    kind: z.enum(["confirm", "text", "secret", "select", "manual_code", "editor"]),
    title: z.string().max(512),
    message: z.string().max(4_096),
    placeholder: z.string().max(512).optional(),
    initialValue: z.string().max(262_144).optional(),
    multiline: z.boolean().optional(),
    options: z.array(z.object({ id: z.string().max(256), label: z.string().max(512) })).max(100).optional()
  }),
  z.object({ type: z.literal("complete"), requestId: z.uuid() }),
  z.object({ type: z.literal("fatal"), requestId: z.uuid().optional(), message: z.string().max(2_048) })
]);

export const desktopRequestSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("choose-project") }),
  z.object({ type: z.literal("get-home-directory") }),
  z.object({ type: z.literal("choose-attachments") }),
  z.object({ type: z.literal("suggest-files"), workspacePath: z.string().max(4_096), prefix: z.string().max(4_096) }),
  z.object({ type: z.literal("load-window-state") }),
  z.object({ type: z.literal("save-window-state"), state: windowViewStateSchema }),
  z.object({ type: z.literal("load-application-state") }),
  z.object({ type: z.literal("list-sessions") }),
  z.object({ type: z.literal("load-session"), workspacePath: z.string().max(4_096), sessionId: z.string().min(1).max(256) }),
  z.object({ type: z.literal("register-project"), path: z.string().max(4_096), name: z.string().min(1).max(512) }),
  z.object({ type: z.literal("rename-project"), path: z.string().max(4_096), name: z.string().min(1).max(512) }),
  z.object({ type: z.literal("remove-project"), path: z.string().max(4_096) }),
  z.object({ type: z.literal("archive-session"), path: z.string().max(4_096), sessionId: z.string().max(256), archived: z.boolean() }),
  z.object({ type: z.literal("new-window") }),
  z.object({ type: z.literal("restart-pi"), path: z.string().max(4_096) }),
  z.object({ type: z.literal("inspect-workspace"), requestId: z.uuid(), path: z.string().max(4_096) }),
  z.object({
    type: z.literal("open-workspace"),
    requestId: z.uuid(),
    path: z.string().max(4_096),
    trusted: z.boolean(),
    newSession: z.boolean().default(false),
    sessionId: z.string().min(1).max(256).optional(),
    sessionFile: z.string().max(4_096).optional()
  }),
  z.object({ type: z.literal("prompt"), requestId: z.uuid(), text: z.string().min(1).max(262_144), delivery: z.enum(["prompt", "steer", "follow-up"]), attachments: z.array(attachmentSchema).max(20), workspacePath: z.string().max(4_096), sessionId: z.string().max(256) }),
  z.object({ type: z.literal("abort"), requestId: z.uuid(), workspacePath: z.string().max(4_096), sessionId: z.string().max(256) }),
  z.object({ type: z.literal("set-model"), requestId: z.uuid(), provider: z.string(), modelId: z.string(), workspacePath: z.string().max(4_096), sessionId: z.string().max(256) }),
  z.object({ type: z.literal("set-thinking"), requestId: z.uuid(), level: thinkingLevelSchema, workspacePath: z.string().max(4_096), sessionId: z.string().max(256) }),
  z.object({ type: z.literal("set-pi-setting"), requestId: z.uuid(), update: piSettingUpdateSchema, workspacePath: z.string().max(4_096), sessionId: z.string().max(256) }),
  z.object({ type: z.literal("login"), requestId: z.uuid(), provider: z.string(), authType: z.enum(["api_key", "oauth"]), workspacePath: z.string().max(4_096), sessionId: z.string().max(256) }),
  z.object({ type: z.literal("logout"), requestId: z.uuid(), provider: z.string(), workspacePath: z.string().max(4_096), sessionId: z.string().max(256) }),
  z.object({ type: z.literal("rename-session"), requestId: z.uuid(), workspacePath: z.string().max(4_096), sessionId: z.string().max(256), name: z.string().min(1).max(512) }),
  z.object({ type: z.literal("fork-session"), requestId: z.uuid(), workspacePath: z.string().max(4_096), sessionId: z.string().max(256), entryId: z.string().max(256) }),
  z.object({ type: z.literal("navigate-session"), requestId: z.uuid(), workspacePath: z.string().max(4_096), sessionId: z.string().max(256), entryId: z.string().max(256) }),
  z.object({ type: z.literal("refresh-session"), requestId: z.uuid(), workspacePath: z.string().max(4_096), sessionId: z.string().max(256) }),
  z.object({ type: z.literal("inspect-changes"), requestId: z.uuid(), workspacePath: z.string().max(4_096) }),
  z.object({ type: z.literal("get-changelog"), requestId: z.uuid(), workspacePath: z.string().max(4_096), sessionId: z.string().max(256) }),
  z.object({ type: z.literal("respond-artifact"), requestId: z.uuid(), artifactRequestId: z.uuid(), workspacePath: z.string().max(4_096), sessionId: z.string().max(256), value: z.unknown().optional(), cancelled: z.boolean() }),
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
  z.object({ type: z.literal("attachments-chosen"), attachments: z.array(attachmentSchema).max(20) }),
  z.object({ type: z.literal("file-suggestions"), suggestions: z.array(fileSuggestionSchema).max(20) }),
  z.object({ type: z.literal("window-state-loaded"), state: windowViewStateSchema }),
  z.object({ type: z.literal("window-state-saved") }),
  z.object({ type: z.literal("application-state-loaded"), state: applicationStateSchema }),
  z.object({ type: z.literal("sessions-listed"), sessions: z.array(globalSessionSummarySchema).max(50_000) }),
  z.object({ type: z.literal("session-loaded"), session: sessionPreviewSchema.optional() }),
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
