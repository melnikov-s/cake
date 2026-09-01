import { Schema } from "effect";
import { artifactRecordSchema } from "./artifact-contract";
import { ipcProjectionArray, ipcProjectionString } from "./projection";
import { sourceLocationSchema } from "./source-location";
import { editorAnnotationSnapshotSchema } from "./editor-annotation";
import {
  customizationStateSchema,
  pluginBackendEventSchema,
  pluginDiagnosticSchema,
  pluginIdSchema,
  pluginPersistenceKeySchema,
  pluginPersistenceRecordSchema,
  pluginPersistenceScopeSchema,
  pluginStatusSchema,
} from "../plugin/plugin-contract";
import {
  compiledInlineWidgetSchema,
  inlineWidgetCapabilitySchema,
  inlineWidgetLanguageSchema,
  inlineWidgetSourceSchema,
  repairedInlineWidgetSchema,
} from "./inline-widget-contract";
import { jsonValueSchema } from "./json-contract";
import {
  pluginAgentOpenOptionsSchema,
  pluginAgentSnapshotSchema,
  pluginCompletionRequestSchema,
  pluginCompletionResultSchema,
  sessionRefSchema,
} from "./plugin-agent-contract";
import {
  applicationStateSchema,
  attachmentSchema,
  extensionUiEventSchema,
  fileSuggestionSchema,
  sessionSnapshotSchema,
  utilityModelSchema,
  uiPartSchema,
} from "./session-contract";
import {
  worktreeLandOutcomeSchema,
  worktreeLandRequestSchema,
  worktreeRecordSchema,
  worktreeStatusSchema,
} from "./worktree-contract";

const bounded = (minimum: number, maximum: number) =>
  Schema.String.check(Schema.isMinLength(minimum), Schema.isMaxLength(maximum));
const stringMax = (maximum: number) => Schema.String.check(Schema.isMaxLength(maximum));
const uuid = Schema.String.check(Schema.isUUID());
const int = Schema.Int;
const nonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const coordinate = Schema.Int.check(Schema.isBetween({ minimum: -1_000_000, maximum: 1_000_000 }));
const requestBase = { requestId: uuid };
const accepted = Schema.Struct({ type: Schema.Literal("accepted"), requestId: uuid });

export const nativeEventSchemas = {
  "pi-state": Schema.Struct({
    type: Schema.Literal("pi-state"),
    state: Schema.Literals(["starting", "ready", "stopped", "failed"]),
    workspacePath: Schema.optional(stringMax(4_096)),
  }),
  "fullscreen-surface-close-requested": Schema.Struct({
    type: Schema.Literal("fullscreen-surface-close-requested"),
    surfaceId: uuid,
  }),
  "workspace-inspected": Schema.Struct({
    type: Schema.Literal("workspace-inspected"),
    requestId: uuid,
    path: stringMax(4_096),
    trustRequired: Schema.Boolean,
  }),
  "session-snapshot": Schema.Struct({
    type: Schema.Literal("session-snapshot"),
    requestId: Schema.optional(uuid),
    snapshot: sessionSnapshotSchema,
  }),
  "part-updated": Schema.Struct({
    type: Schema.Literal("part-updated"),
    sessionId: Schema.String,
    part: uiPartSchema,
  }),
  "part-removed": Schema.Struct({
    type: Schema.Literal("part-removed"),
    sessionId: Schema.String,
    partId: stringMax(256),
  }),
  "session-streaming": Schema.Struct({
    type: Schema.Literal("session-streaming"),
    sessionId: Schema.String,
    streaming: Schema.Boolean,
  }),
  "extension-ui": Schema.Struct({
    type: Schema.Literal("extension-ui"),
    sessionId: stringMax(256),
    event: extensionUiEventSchema,
  }),
  "changelog-snapshot": Schema.Struct({
    type: Schema.Literal("changelog-snapshot"),
    requestId: uuid,
    workspacePath: stringMax(4_096),
    sessionId: stringMax(256),
    markdown: ipcProjectionString(1_000_000),
  }),
  "artifact-updated": Schema.Struct({
    type: Schema.Literal("artifact-updated"),
    record: artifactRecordSchema,
  }),
  "artifact-requested": Schema.Struct({
    type: Schema.Literal("artifact-requested"),
    requestId: uuid,
    artifactRequestId: uuid,
    record: artifactRecordSchema,
  }),
  "ui-request": Schema.Struct({
    type: Schema.Literal("ui-request"),
    requestId: uuid,
    uiRequestId: uuid,
    kind: Schema.Literals(["confirm", "text", "secret", "select", "manual_code", "editor"]),
    title: ipcProjectionString(512),
    message: ipcProjectionString(4_096),
    placeholder: Schema.optional(ipcProjectionString(512)),
    initialValue: Schema.optional(ipcProjectionString(262_144)),
    multiline: Schema.optional(Schema.Boolean),
    options: Schema.optional(
      ipcProjectionArray(
        Schema.Struct({ id: ipcProjectionString(256), label: ipcProjectionString(512) }),
        100,
      ),
    ),
  }),
  complete: Schema.Struct({ type: Schema.Literal("complete"), requestId: uuid }),
  fatal: Schema.Struct({
    type: Schema.Literal("fatal"),
    requestId: Schema.optional(uuid),
    message: ipcProjectionString(2_048),
    details: Schema.optional(ipcProjectionString(16_384)),
  }),
  "plugin-backend-event": pluginBackendEventSchema.pipe(
    Schema.fieldsAssign({ type: Schema.Literal("plugin-backend-event") }),
  ),
  "customization-state-changed": Schema.Struct({
    type: Schema.Literal("customization-state-changed"),
    state: customizationStateSchema,
  }),
  "application-state-changed": Schema.Struct({
    type: Schema.Literal("application-state-changed"),
    state: applicationStateSchema,
  }),
  notification: Schema.Struct({
    type: Schema.Literal("notification"),
    tone: Schema.Literals(["info", "warning", "error"]),
    title: ipcProjectionString(256),
    message: ipcProjectionString(2_048),
  }),
  "plugin-agent-event": Schema.Struct({
    type: Schema.Literal("plugin-agent-event"),
    pluginId: pluginIdSchema,
    snapshot: pluginAgentSnapshotSchema,
  }),
  "terminal-data": Schema.Struct({
    type: Schema.Literal("terminal-data"),
    terminalId: uuid,
    data: ipcProjectionString(262_144),
  }),
  "terminal-exited": Schema.Struct({
    type: Schema.Literal("terminal-exited"),
    terminalId: uuid,
    exitCode: int,
  }),
  "terminal-toggle-requested": Schema.Struct({ type: Schema.Literal("terminal-toggle-requested") }),
  "embedded-editor-state": Schema.Struct({
    type: Schema.Literal("embedded-editor-state"),
    status: Schema.Literals(["missing", "downloading", "starting", "ready", "failed"]),
    message: Schema.optional(ipcProjectionString(4_096)),
  }),
  "embedded-editor-selection": Schema.Struct({
    type: Schema.Literal("embedded-editor-selection"),
    workspacePath: stringMax(4_096),
    path: ipcProjectionString(8_192),
    startLine: nonNegativeInt,
    endLine: nonNegativeInt,
  }),
  "embedded-editor-back-to-agent": Schema.Struct({
    type: Schema.Literal("embedded-editor-back-to-agent"),
    workspacePath: stringMax(4_096),
  }),
  "embedded-editor-annotation-opened": Schema.Struct({
    type: Schema.Literal("embedded-editor-annotation-opened"),
    workspacePath: stringMax(4_096),
    sessionId: bounded(1, 256),
    threadId: bounded(1, 256),
  }),
  "embedded-editor-toggle-chat": Schema.Struct({
    type: Schema.Literal("embedded-editor-toggle-chat"),
    workspacePath: stringMax(4_096),
  }),
  "embedded-editor-selection-cleared": Schema.Struct({
    type: Schema.Literal("embedded-editor-selection-cleared"),
    workspacePath: stringMax(4_096),
  }),
  "embedded-editor-location-opened": Schema.Struct({
    type: Schema.Literal("embedded-editor-location-opened"),
    workspacePath: stringMax(4_096),
    location: sourceLocationSchema,
  }),
} as const;

export const applicationEventSchema = Schema.Union([
  nativeEventSchemas["pi-state"],
  nativeEventSchemas["workspace-inspected"],
  nativeEventSchemas["changelog-snapshot"],
  nativeEventSchemas.complete,
  nativeEventSchemas.fatal,
  nativeEventSchemas["application-state-changed"],
  nativeEventSchemas.notification,
]);

export const artifactEventSchema = Schema.Union([
  nativeEventSchemas["artifact-updated"],
  nativeEventSchemas["artifact-requested"],
  nativeEventSchemas["ui-request"],
]);

export const pluginEventSchema = Schema.Union([
  nativeEventSchemas["plugin-backend-event"],
  nativeEventSchemas["customization-state-changed"],
  nativeEventSchemas["plugin-agent-event"],
]);

export const terminalEventSchema = Schema.Union([
  nativeEventSchemas["terminal-data"],
  nativeEventSchemas["terminal-exited"],
  nativeEventSchemas["terminal-toggle-requested"],
]);

export const embeddedEditorEventSchema = Schema.Union([
  nativeEventSchemas["embedded-editor-state"],
  nativeEventSchemas["embedded-editor-selection"],
  nativeEventSchemas["embedded-editor-back-to-agent"],
  nativeEventSchemas["embedded-editor-annotation-opened"],
  nativeEventSchemas["embedded-editor-toggle-chat"],
  nativeEventSchemas["embedded-editor-selection-cleared"],
  nativeEventSchemas["embedded-editor-location-opened"],
]);

export const surfaceEventSchema = nativeEventSchemas["fullscreen-surface-close-requested"];

export const nativeEventSchema = Schema.Union([
  nativeEventSchemas["pi-state"],
  nativeEventSchemas["fullscreen-surface-close-requested"],
  nativeEventSchemas["workspace-inspected"],
  nativeEventSchemas["session-snapshot"],
  nativeEventSchemas["part-updated"],
  nativeEventSchemas["part-removed"],
  nativeEventSchemas["session-streaming"],
  nativeEventSchemas["extension-ui"],
  nativeEventSchemas["changelog-snapshot"],
  nativeEventSchemas["artifact-updated"],
  nativeEventSchemas["artifact-requested"],
  nativeEventSchemas["ui-request"],
  nativeEventSchemas["complete"],
  nativeEventSchemas["fatal"],
  nativeEventSchemas["plugin-backend-event"],
  nativeEventSchemas["customization-state-changed"],
  nativeEventSchemas["application-state-changed"],
  nativeEventSchemas["notification"],
  nativeEventSchemas["plugin-agent-event"],
  nativeEventSchemas["terminal-data"],
  nativeEventSchemas["terminal-exited"],
  nativeEventSchemas["terminal-toggle-requested"],
  nativeEventSchemas["embedded-editor-state"],
  nativeEventSchemas["embedded-editor-selection"],
  nativeEventSchemas["embedded-editor-back-to-agent"],
  nativeEventSchemas["embedded-editor-annotation-opened"],
  nativeEventSchemas["embedded-editor-toggle-chat"],
  nativeEventSchemas["embedded-editor-selection-cleared"],
  nativeEventSchemas["embedded-editor-location-opened"],
]);

const terminalTarget = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("project"),
    sessionId: bounded(1, 256),
    workspacePath: bounded(1, 4_096),
  }),
  Schema.Struct({ kind: Schema.Literal("cake-chat"), sessionId: bounded(1, 256) }),
]);

export const nativeCommandSchemas = {
  "choose-project": Schema.Struct({ type: Schema.Literal("choose-project") }),
  "open-external-url": Schema.Struct({
    type: Schema.Literal("open-external-url"),
    url: stringMax(8_192),
  }),
  "show-transcript-selection-context-menu": Schema.Struct({
    type: Schema.Literal("show-transcript-selection-context-menu"),
    canChat: Schema.Boolean,
    canAnnotate: Schema.Boolean,
  }),
  "set-fullscreen-surface-open": Schema.Struct({
    type: Schema.Literal("set-fullscreen-surface-open"),
    ...requestBase,
    surfaceId: uuid,
    open: Schema.Boolean,
  }),
  "show-composer-context-menu": Schema.Struct({
    type: Schema.Literal("show-composer-context-menu"),
    selection: bounded(1, 32_000),
    x: coordinate,
    y: coordinate,
  }),
  "reword-composer-selection": Schema.Struct({
    type: Schema.Literal("reword-composer-selection"),
    selection: bounded(1, 32_000),
    prompt: Schema.optional(stringMax(4_096)),
    workspacePath: Schema.optional(bounded(1, 4_096)),
  }),
  "generate-session-title": Schema.Struct({
    type: Schema.Literal("generate-session-title"),
    firstUserMessage: bounded(1, 262_144),
  }),
  "show-session-context-menu": Schema.Struct({
    type: Schema.Literal("show-session-context-menu"),
    sessionId: bounded(1, 256),
    x: coordinate,
    y: coordinate,
    resolved: Schema.Boolean,
    unread: Schema.optional(Schema.Boolean),
  }),
  "show-project-context-menu": Schema.Struct({
    type: Schema.Literal("show-project-context-menu"),
    path: bounded(1, 4_096),
    x: coordinate,
    y: coordinate,
    resolvedWorktreeCount: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 500 })),
  }),
  "open-terminal": Schema.Struct({
    type: Schema.Literal("open-terminal"),
    ...requestBase,
    target: terminalTarget,
    cols: Schema.Int.check(Schema.isBetween({ minimum: 2, maximum: 1_000 })),
    rows: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1_000 })),
  }),
  "write-terminal": Schema.Struct({
    type: Schema.Literal("write-terminal"),
    ...requestBase,
    terminalId: uuid,
    data: stringMax(262_144),
  }),
  "resize-terminal": Schema.Struct({
    type: Schema.Literal("resize-terminal"),
    ...requestBase,
    terminalId: uuid,
    cols: Schema.Int.check(Schema.isBetween({ minimum: 2, maximum: 1_000 })),
    rows: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1_000 })),
  }),
  "get-terminal-status": Schema.Struct({
    type: Schema.Literal("get-terminal-status"),
    ...requestBase,
    terminalId: uuid,
  }),
  "close-terminal": Schema.Struct({
    type: Schema.Literal("close-terminal"),
    ...requestBase,
    terminalId: uuid,
  }),
  "set-vscode-server-path": Schema.Struct({
    type: Schema.Literal("set-vscode-server-path"),
    path: Schema.optional(stringMax(4_096)),
  }),
  "get-embedded-editor-state": Schema.Struct({ type: Schema.Literal("get-embedded-editor-state") }),
  "install-embedded-editor": Schema.Struct({
    type: Schema.Literal("install-embedded-editor"),
    ...requestBase,
  }),
  "open-embedded-editor": Schema.Struct({
    type: Schema.Literal("open-embedded-editor"),
    ...requestBase,
    workspacePath: stringMax(4_096),
  }),
  "update-embedded-editor-bounds": Schema.Struct({
    type: Schema.Literal("update-embedded-editor-bounds"),
    ...requestBase,
    visible: Schema.Boolean,
    x: Schema.Number,
    y: Schema.Number,
    width: Schema.Number.check(
      Schema.isGreaterThanOrEqualTo(0),
      Schema.isLessThanOrEqualTo(100_000),
    ),
    height: Schema.Number.check(
      Schema.isGreaterThanOrEqualTo(0),
      Schema.isLessThanOrEqualTo(100_000),
    ),
  }),
  "reveal-in-embedded-editor": Schema.Struct({
    type: Schema.Literal("reveal-in-embedded-editor"),
    ...requestBase,
    workspacePath: stringMax(4_096),
    location: sourceLocationSchema,
  }),
  "open-embedded-editor-source-control": Schema.Struct({
    type: Schema.Literal("open-embedded-editor-source-control"),
    ...requestBase,
    workspacePath: stringMax(4_096),
  }),
  "update-embedded-editor-annotations": Schema.Struct({
    type: Schema.Literal("update-embedded-editor-annotations"),
    ...requestBase,
    workspacePath: stringMax(4_096),
    snapshot: editorAnnotationSnapshotSchema,
  }),
  "get-customization-state": Schema.Struct({ type: Schema.Literal("get-customization-state") }),
  "get-plugin-authoring-reference": Schema.Struct({
    type: Schema.Literal("get-plugin-authoring-reference"),
  }),
  "list-plugin-files": Schema.Struct({ type: Schema.Literal("list-plugin-files") }),
  "create-plugin": Schema.Struct({
    type: Schema.Literal("create-plugin"),
    pluginId: pluginIdSchema,
    name: Schema.Trim.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(128))),
    renderer: Schema.Boolean,
    backend: Schema.Boolean,
    scene: Schema.Boolean,
    expectedWorkingRevision: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  }),
  "read-plugin-file": Schema.Struct({
    type: Schema.Literal("read-plugin-file"),
    pluginId: pluginIdSchema,
    path: bounded(1, 8_192),
  }),
  "write-plugin-file": Schema.Struct({
    type: Schema.Literal("write-plugin-file"),
    pluginId: pluginIdSchema,
    path: bounded(1, 8_192),
    content: stringMax(2_000_000),
    expectedWorkingRevision: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  }),
  "validate-customization": Schema.Struct({
    type: Schema.Literal("validate-customization"),
    expectedBaseRevision: Schema.optional(Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))),
    expectedSourceRevision: Schema.optional(
      Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
    ),
    request: Schema.optional(ipcProjectionString(8_192)),
  }),
  "activate-customization": Schema.Struct({
    type: Schema.Literal("activate-customization"),
    revision: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
    expectedSourceRevision: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
    request: Schema.optional(ipcProjectionString(8_192)),
  }),
  "customization-rendered": Schema.Struct({
    type: Schema.Literal("customization-rendered"),
    revision: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  }),
  "customization-runtime-failed": Schema.Struct({
    type: Schema.Literal("customization-runtime-failed"),
    revision: Schema.optional(Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))),
    message: ipcProjectionString(32_768),
  }),
  "rollback-customization": Schema.Struct({ type: Schema.Literal("rollback-customization") }),
  "use-factory-customization": Schema.Struct({ type: Schema.Literal("use-factory-customization") }),
  "list-plugins": Schema.Struct({ type: Schema.Literal("list-plugins") }),
  "set-plugin-enabled": Schema.Struct({
    type: Schema.Literal("set-plugin-enabled"),
    pluginId: pluginIdSchema,
    enabled: Schema.Boolean,
  }),
  "set-active-scene": Schema.Struct({
    type: Schema.Literal("set-active-scene"),
    pluginId: Schema.optional(pluginIdSchema),
  }),
  "delete-plugin": Schema.Struct({
    type: Schema.Literal("delete-plugin"),
    pluginId: pluginIdSchema,
  }),
  "call-plugin-backend": Schema.Struct({
    type: Schema.Literal("call-plugin-backend"),
    pluginId: pluginIdSchema,
    callId: uuid,
    method: Schema.String.check(
      Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
      Schema.isMaxLength(256),
    ),
    input: jsonValueSchema,
  }),
  "cancel-plugin-backend-call": Schema.Struct({
    type: Schema.Literal("cancel-plugin-backend-call"),
    pluginId: pluginIdSchema,
    callId: uuid,
  }),
  "open-plugin-agent": Schema.Struct({
    type: Schema.Literal("open-plugin-agent"),
    pluginId: pluginIdSchema,
    options: pluginAgentOpenOptionsSchema,
    implicitSession: Schema.optional(sessionRefSchema),
  }),
  "prompt-plugin-agent": Schema.Struct({
    type: Schema.Literal("prompt-plugin-agent"),
    pluginId: pluginIdSchema,
    handleId: uuid,
    delivery: Schema.Literals(["prompt", "steer", "follow-up"]),
    text: bounded(1, 262_144),
  }),
  "abort-plugin-agent": Schema.Struct({
    type: Schema.Literal("abort-plugin-agent"),
    pluginId: pluginIdSchema,
    handleId: uuid,
  }),
  "detach-plugin-agent": Schema.Struct({
    type: Schema.Literal("detach-plugin-agent"),
    pluginId: pluginIdSchema,
    handleId: uuid,
  }),
  "run-plugin-completion": Schema.Struct({
    type: Schema.Literal("run-plugin-completion"),
    pluginId: pluginIdSchema,
    ...requestBase,
    request: pluginCompletionRequestSchema,
    implicitSession: Schema.optional(sessionRefSchema),
  }),
  "cancel-plugin-completion": Schema.Struct({
    type: Schema.Literal("cancel-plugin-completion"),
    pluginId: pluginIdSchema,
    ...requestBase,
  }),
  "load-plugin-state": Schema.Struct({
    type: Schema.Literal("load-plugin-state"),
    pluginId: pluginIdSchema,
    key: pluginPersistenceKeySchema,
    scope: pluginPersistenceScopeSchema,
  }),
  "save-plugin-state": Schema.Struct({
    type: Schema.Literal("save-plugin-state"),
    pluginId: pluginIdSchema,
    key: pluginPersistenceKeySchema,
    scope: pluginPersistenceScopeSchema,
    value: Schema.Json,
    expectedVersion: Schema.optional(nonNegativeInt),
  }),
  "choose-attachments": Schema.Struct({ type: Schema.Literal("choose-attachments") }),
  "suggest-files": Schema.Struct({
    type: Schema.Literal("suggest-files"),
    workspacePath: stringMax(4_096),
    prefix: stringMax(4_096),
  }),
  "read-workspace-file": Schema.Struct({
    type: Schema.Literal("read-workspace-file"),
    workspacePath: stringMax(4_096),
    path: bounded(1, 8_192),
  }),
  "compile-inline-widget": Schema.Struct({
    type: Schema.Literal("compile-inline-widget"),
    language: inlineWidgetLanguageSchema,
    capability: inlineWidgetCapabilitySchema,
    source: inlineWidgetSourceSchema,
  }),
  "repair-inline-widget": Schema.Struct({
    type: Schema.Literal("repair-inline-widget"),
    sessionId: bounded(1, 256),
    language: inlineWidgetLanguageSchema,
    capability: inlineWidgetCapabilitySchema,
    source: inlineWidgetSourceSchema,
    context: stringMax(262_144),
    diagnostic: Schema.optional(stringMax(32_768)),
    model: Schema.optional(Schema.Struct({ provider: bounded(1, 256), id: bounded(1, 512) })),
  }),
  "set-utility-model": Schema.Struct({
    type: Schema.Literal("set-utility-model"),
    model: Schema.optional(utilityModelSchema),
  }),
  "register-project": Schema.Struct({
    type: Schema.Literal("register-project"),
    path: stringMax(4_096),
    name: bounded(1, 512),
  }),
  "rename-project": Schema.Struct({
    type: Schema.Literal("rename-project"),
    path: stringMax(4_096),
    name: bounded(1, 512),
  }),
  "remove-project": Schema.Struct({
    type: Schema.Literal("remove-project"),
    path: stringMax(4_096),
    deleteSessions: Schema.Boolean,
  }),
  "delete-session": Schema.Struct({
    type: Schema.Literal("delete-session"),
    sessionId: bounded(1, 256),
  }),
  "set-session-unread": Schema.Struct({
    type: Schema.Literal("set-session-unread"),
    sessionId: bounded(1, 256),
    unread: Schema.Boolean,
  }),
  "restart-pi": Schema.Struct({ type: Schema.Literal("restart-pi"), path: stringMax(4_096) }),
  "create-worktree": Schema.Struct({
    type: Schema.Literal("create-worktree"),
    ...requestBase,
    path: stringMax(4_096),
    baseWorktreePath: Schema.optional(bounded(1, 4_096)),
    worktreeName: Schema.optional(
      Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,62}$/)),
    ),
    firstUserMessage: Schema.optional(bounded(1, 262_144)),
  }),
  "get-worktree-status": Schema.Struct({
    type: Schema.Literal("get-worktree-status"),
    workspacePath: stringMax(4_096),
  }),
  "land-worktree": Schema.Struct({
    type: Schema.Literal("land-worktree"),
    ...requestBase,
    workspacePath: stringMax(4_096),
    request: worktreeLandRequestSchema,
  }),
  "discard-worktree": Schema.Struct({
    type: Schema.Literal("discard-worktree"),
    ...requestBase,
    workspacePath: stringMax(4_096),
    keepBranch: Schema.Boolean,
  }),
  "inspect-workspace": Schema.Struct({
    type: Schema.Literal("inspect-workspace"),
    ...requestBase,
    path: stringMax(4_096),
  }),
  "respond-workspace-trust": Schema.Struct({
    type: Schema.Literal("respond-workspace-trust"),
    ...requestBase,
    path: stringMax(4_096),
    approved: Schema.Boolean,
  }),
  "respond-artifact": Schema.Struct({
    type: Schema.Literal("respond-artifact"),
    ...requestBase,
    artifactRequestId: uuid,
    sessionId: stringMax(256),
    value: Schema.optional(jsonValueSchema),
    cancelled: Schema.Boolean,
  }),
  "export-artifacts": Schema.Struct({
    type: Schema.Literal("export-artifacts"),
    sessionId: stringMax(256),
  }),
  "respond-ui": Schema.Struct({
    type: Schema.Literal("respond-ui"),
    ...requestBase,
    uiRequestId: uuid,
    value: Schema.optional(stringMax(262_144)),
    cancelled: Schema.Boolean,
    sessionId: stringMax(256),
  }),
} as const;

export const nativeCommandSchema = Schema.Union([
  nativeCommandSchemas["choose-project"],
  nativeCommandSchemas["open-external-url"],
  nativeCommandSchemas["show-transcript-selection-context-menu"],
  nativeCommandSchemas["set-fullscreen-surface-open"],
  nativeCommandSchemas["show-composer-context-menu"],
  nativeCommandSchemas["reword-composer-selection"],
  nativeCommandSchemas["generate-session-title"],
  nativeCommandSchemas["show-session-context-menu"],
  nativeCommandSchemas["show-project-context-menu"],
  nativeCommandSchemas["open-terminal"],
  nativeCommandSchemas["write-terminal"],
  nativeCommandSchemas["resize-terminal"],
  nativeCommandSchemas["get-terminal-status"],
  nativeCommandSchemas["close-terminal"],
  nativeCommandSchemas["set-vscode-server-path"],
  nativeCommandSchemas["get-embedded-editor-state"],
  nativeCommandSchemas["install-embedded-editor"],
  nativeCommandSchemas["open-embedded-editor"],
  nativeCommandSchemas["update-embedded-editor-bounds"],
  nativeCommandSchemas["reveal-in-embedded-editor"],
  nativeCommandSchemas["open-embedded-editor-source-control"],
  nativeCommandSchemas["update-embedded-editor-annotations"],
  nativeCommandSchemas["get-customization-state"],
  nativeCommandSchemas["get-plugin-authoring-reference"],
  nativeCommandSchemas["list-plugin-files"],
  nativeCommandSchemas["create-plugin"],
  nativeCommandSchemas["read-plugin-file"],
  nativeCommandSchemas["write-plugin-file"],
  nativeCommandSchemas["validate-customization"],
  nativeCommandSchemas["activate-customization"],
  nativeCommandSchemas["customization-rendered"],
  nativeCommandSchemas["customization-runtime-failed"],
  nativeCommandSchemas["rollback-customization"],
  nativeCommandSchemas["use-factory-customization"],
  nativeCommandSchemas["list-plugins"],
  nativeCommandSchemas["set-plugin-enabled"],
  nativeCommandSchemas["set-active-scene"],
  nativeCommandSchemas["delete-plugin"],
  nativeCommandSchemas["call-plugin-backend"],
  nativeCommandSchemas["cancel-plugin-backend-call"],
  nativeCommandSchemas["open-plugin-agent"],
  nativeCommandSchemas["prompt-plugin-agent"],
  nativeCommandSchemas["abort-plugin-agent"],
  nativeCommandSchemas["detach-plugin-agent"],
  nativeCommandSchemas["run-plugin-completion"],
  nativeCommandSchemas["cancel-plugin-completion"],
  nativeCommandSchemas["load-plugin-state"],
  nativeCommandSchemas["save-plugin-state"],
  nativeCommandSchemas["choose-attachments"],
  nativeCommandSchemas["suggest-files"],
  nativeCommandSchemas["read-workspace-file"],
  nativeCommandSchemas["compile-inline-widget"],
  nativeCommandSchemas["repair-inline-widget"],
  nativeCommandSchemas["set-utility-model"],
  nativeCommandSchemas["register-project"],
  nativeCommandSchemas["rename-project"],
  nativeCommandSchemas["remove-project"],
  nativeCommandSchemas["delete-session"],
  nativeCommandSchemas["set-session-unread"],
  nativeCommandSchemas["restart-pi"],
  nativeCommandSchemas["create-worktree"],
  nativeCommandSchemas["get-worktree-status"],
  nativeCommandSchemas["land-worktree"],
  nativeCommandSchemas["discard-worktree"],
  nativeCommandSchemas["inspect-workspace"],
  nativeCommandSchemas["respond-workspace-trust"],
  nativeCommandSchemas["respond-artifact"],
  nativeCommandSchemas["export-artifacts"],
  nativeCommandSchemas["respond-ui"],
]);

const nativeCommandResultSchemas = {
  "project-chosen": Schema.Struct({
    type: Schema.Literal("project-chosen"),
    path: Schema.optional(stringMax(4_096)),
  }),
  "external-url-opened": Schema.Struct({ type: Schema.Literal("external-url-opened") }),
  "transcript-selection-context-menu-closed": Schema.Struct({
    type: Schema.Literal("transcript-selection-context-menu-closed"),
    action: Schema.optional(Schema.Literals(["chat-about-selection", "add-annotation"])),
  }),
  "composer-context-menu-closed": Schema.Struct({
    type: Schema.Literal("composer-context-menu-closed"),
    action: Schema.optional(Schema.Literals(["reword", "reword-with-prompt"])),
  }),
  "composer-selection-reworded": Schema.Struct({
    type: Schema.Literal("composer-selection-reworded"),
    text: bounded(1, 32_000),
  }),
  "session-title-generated": Schema.Struct({
    type: Schema.Literal("session-title-generated"),
    title: Schema.optional(bounded(1, 80)),
  }),
  "session-context-menu-closed": Schema.Struct({
    type: Schema.Literal("session-context-menu-closed"),
    action: Schema.optional(
      Schema.Literals(["rename", "mark-unread", "resolve", "unresolve", "delete"]),
    ),
  }),
  "project-context-menu-closed": Schema.Struct({
    type: Schema.Literal("project-context-menu-closed"),
    action: Schema.optional(Schema.Literals(["remove-project", "delete-resolved-worktrees"])),
  }),
  "embedded-editor-state-loaded": Schema.Struct({
    type: Schema.Literal("embedded-editor-state-loaded"),
    status: Schema.Literals(["missing", "downloading", "starting", "ready", "failed"]),
    message: Schema.optional(ipcProjectionString(4_096)),
    customPath: Schema.optional(stringMax(4_096)),
  }),
  "terminal-opened": Schema.Struct({
    type: Schema.Literal("terminal-opened"),
    ...requestBase,
    terminalId: uuid,
    shell: bounded(1, 256),
  }),
  "terminal-status": Schema.Struct({
    type: Schema.Literal("terminal-status"),
    ...requestBase,
    runningProgram: Schema.Boolean,
  }),
  "customization-state": Schema.Struct({
    type: Schema.Literal("customization-state"),
    state: customizationStateSchema,
  }),
  "plugin-authoring-reference": Schema.Struct({
    type: Schema.Literal("plugin-authoring-reference"),
    reference: stringMax(1_000_000),
  }),
  "plugin-files": Schema.Struct({
    type: Schema.Literal("plugin-files"),
    workingRevision: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
    buildRevision: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
    files: Schema.Array(bounded(1, 8_192)).check(Schema.isMaxLength(100_000)),
  }),
  "plugin-file": Schema.Struct({
    type: Schema.Literal("plugin-file"),
    pluginId: pluginIdSchema,
    path: bounded(1, 8_192),
    content: stringMax(2_000_000),
  }),
  "customization-validation": Schema.Struct({
    type: Schema.Literal("customization-validation"),
    revision: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
    sourceRevision: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
    diagnostics: Schema.Array(pluginDiagnosticSchema).check(Schema.isMaxLength(1_000)),
    valid: Schema.Boolean,
  }),
  "customization-activation": Schema.Struct({
    type: Schema.Literal("customization-activation"),
    revision: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
    activating: Schema.Literal(true),
  }),
  "plugin-state": Schema.Struct({
    type: Schema.Literal("plugin-state"),
    record: Schema.optional(pluginPersistenceRecordSchema),
  }),
  "plugins-listed": Schema.Struct({
    type: Schema.Literal("plugins-listed"),
    plugins: Schema.Array(pluginStatusSchema).check(Schema.isMaxLength(1_000)),
  }),
  "plugin-backend-result": Schema.Struct({
    type: Schema.Literal("plugin-backend-result"),
    callId: uuid,
    ok: Schema.Boolean,
    value: Schema.optional(jsonValueSchema),
    error: Schema.optional(ipcProjectionString(32_768)),
  }),
  "plugin-agent-snapshot": Schema.Struct({
    type: Schema.Literal("plugin-agent-snapshot"),
    snapshot: pluginAgentSnapshotSchema,
  }),
  "plugin-agent-detached": Schema.Struct({
    type: Schema.Literal("plugin-agent-detached"),
    handleId: uuid,
  }),
  "plugin-completion-result": Schema.Struct({
    type: Schema.Literal("plugin-completion-result"),
    requestId: uuid,
    result: pluginCompletionResultSchema,
  }),
  "attachments-chosen": Schema.Struct({
    type: Schema.Literal("attachments-chosen"),
    attachments: Schema.Array(attachmentSchema).check(Schema.isMaxLength(20)),
  }),
  "file-suggestions": Schema.Struct({
    type: Schema.Literal("file-suggestions"),
    suggestions: Schema.Array(fileSuggestionSchema).check(Schema.isMaxLength(20)),
  }),
  "workspace-file": Schema.Struct({
    type: Schema.Literal("workspace-file"),
    content: stringMax(2_000_000),
  }),
  "inline-widget-compiled": Schema.Struct({
    type: Schema.Literal("inline-widget-compiled"),
    widget: compiledInlineWidgetSchema,
  }),
  "inline-widget-repaired": Schema.Struct({
    type: Schema.Literal("inline-widget-repaired"),
    widget: repairedInlineWidgetSchema,
  }),
  "application-state-updated": Schema.Struct({
    type: Schema.Literal("application-state-updated"),
    state: applicationStateSchema,
  }),
  "worktree-created": Schema.Struct({
    type: Schema.Literal("worktree-created"),
    ...requestBase,
    record: worktreeRecordSchema,
  }),
  "worktree-status-loaded": Schema.Struct({
    type: Schema.Literal("worktree-status-loaded"),
    status: Schema.optional(worktreeStatusSchema),
  }),
  "worktree-landed": Schema.Struct({
    type: Schema.Literal("worktree-landed"),
    ...requestBase,
    result: worktreeLandOutcomeSchema,
  }),
  accepted: accepted,
  "ui-response-accepted": Schema.Struct({
    type: Schema.Literal("ui-response-accepted"),
    uiRequestId: uuid,
  }),
  "artifact-response-accepted": Schema.Struct({
    type: Schema.Literal("artifact-response-accepted"),
    artifactRequestId: uuid,
  }),
  "artifacts-exported": Schema.Struct({
    type: Schema.Literal("artifacts-exported"),
    markdown: stringMax(20_000_000),
  }),
} as const;

export const nativeCommandResultSchema = Schema.Union([
  nativeCommandResultSchemas["project-chosen"],
  nativeCommandResultSchemas["external-url-opened"],
  nativeCommandResultSchemas["transcript-selection-context-menu-closed"],
  nativeCommandResultSchemas["composer-context-menu-closed"],
  nativeCommandResultSchemas["composer-selection-reworded"],
  nativeCommandResultSchemas["session-title-generated"],
  nativeCommandResultSchemas["session-context-menu-closed"],
  nativeCommandResultSchemas["project-context-menu-closed"],
  nativeCommandResultSchemas["embedded-editor-state-loaded"],
  nativeCommandResultSchemas["terminal-opened"],
  nativeCommandResultSchemas["terminal-status"],
  nativeCommandResultSchemas["customization-state"],
  nativeCommandResultSchemas["plugin-authoring-reference"],
  nativeCommandResultSchemas["plugin-files"],
  nativeCommandResultSchemas["plugin-file"],
  nativeCommandResultSchemas["customization-validation"],
  nativeCommandResultSchemas["customization-activation"],
  nativeCommandResultSchemas["plugin-state"],
  nativeCommandResultSchemas["plugins-listed"],
  nativeCommandResultSchemas["plugin-backend-result"],
  nativeCommandResultSchemas["plugin-agent-snapshot"],
  nativeCommandResultSchemas["plugin-agent-detached"],
  nativeCommandResultSchemas["plugin-completion-result"],
  nativeCommandResultSchemas["attachments-chosen"],
  nativeCommandResultSchemas["file-suggestions"],
  nativeCommandResultSchemas["workspace-file"],
  nativeCommandResultSchemas["inline-widget-compiled"],
  nativeCommandResultSchemas["inline-widget-repaired"],
  nativeCommandResultSchemas["application-state-updated"],
  nativeCommandResultSchemas["worktree-created"],
  nativeCommandResultSchemas["worktree-status-loaded"],
  nativeCommandResultSchemas["worktree-landed"],
  nativeCommandResultSchemas["accepted"],
  nativeCommandResultSchemas["ui-response-accepted"],
  nativeCommandResultSchemas["artifact-response-accepted"],
  nativeCommandResultSchemas["artifacts-exported"],
]);

export const nativeCommandSuccessSchemas = {
  "choose-project": nativeCommandResultSchemas["project-chosen"],
  "open-external-url": nativeCommandResultSchemas["external-url-opened"],
  "show-transcript-selection-context-menu":
    nativeCommandResultSchemas["transcript-selection-context-menu-closed"],
  "show-composer-context-menu": nativeCommandResultSchemas["composer-context-menu-closed"],
  "show-session-context-menu": nativeCommandResultSchemas["session-context-menu-closed"],
  "show-project-context-menu": nativeCommandResultSchemas["project-context-menu-closed"],
  "set-fullscreen-surface-open": nativeCommandResultSchemas.accepted,
  "choose-attachments": nativeCommandResultSchemas["attachments-chosen"],
  "suggest-files": nativeCommandResultSchemas["file-suggestions"],
  "read-workspace-file": nativeCommandResultSchemas["workspace-file"],
  "reword-composer-selection": nativeCommandResultSchemas["composer-selection-reworded"],
  "generate-session-title": nativeCommandResultSchemas["session-title-generated"],
  "set-utility-model": nativeCommandResultSchemas["application-state-updated"],
  "register-project": nativeCommandResultSchemas["application-state-updated"],
  "rename-project": nativeCommandResultSchemas["application-state-updated"],
  "remove-project": nativeCommandResultSchemas["application-state-updated"],
  "delete-session": nativeCommandResultSchemas["application-state-updated"],
  "set-session-unread": nativeCommandResultSchemas["application-state-updated"],
  "restart-pi": nativeCommandResultSchemas.accepted,
  "inspect-workspace": nativeCommandResultSchemas.accepted,
  "respond-workspace-trust": nativeCommandResultSchemas.accepted,
  "create-worktree": nativeCommandResultSchemas["worktree-created"],
  "get-worktree-status": nativeCommandResultSchemas["worktree-status-loaded"],
  "land-worktree": nativeCommandResultSchemas["worktree-landed"],
  "discard-worktree": nativeCommandResultSchemas.accepted,
  "open-terminal": nativeCommandResultSchemas["terminal-opened"],
  "write-terminal": nativeCommandResultSchemas.accepted,
  "resize-terminal": nativeCommandResultSchemas.accepted,
  "get-terminal-status": nativeCommandResultSchemas["terminal-status"],
  "close-terminal": nativeCommandResultSchemas.accepted,
  "get-embedded-editor-state": nativeCommandResultSchemas["embedded-editor-state-loaded"],
  "install-embedded-editor": nativeCommandResultSchemas.accepted,
  "set-vscode-server-path": nativeCommandResultSchemas["application-state-updated"],
  "open-embedded-editor": nativeCommandResultSchemas.accepted,
  "update-embedded-editor-bounds": nativeCommandResultSchemas.accepted,
  "reveal-in-embedded-editor": nativeCommandResultSchemas.accepted,
  "open-embedded-editor-source-control": nativeCommandResultSchemas.accepted,
  "update-embedded-editor-annotations": nativeCommandResultSchemas.accepted,
  "respond-artifact": nativeCommandResultSchemas["artifact-response-accepted"],
  "respond-ui": nativeCommandResultSchemas["ui-response-accepted"],
  "export-artifacts": nativeCommandResultSchemas["artifacts-exported"],
  "get-customization-state": nativeCommandResultSchemas["customization-state"],
  "get-plugin-authoring-reference": nativeCommandResultSchemas["plugin-authoring-reference"],
  "list-plugin-files": nativeCommandResultSchemas["plugin-files"],
  "create-plugin": nativeCommandResultSchemas["plugin-files"],
  "read-plugin-file": nativeCommandResultSchemas["plugin-file"],
  "write-plugin-file": nativeCommandResultSchemas["plugin-files"],
  "validate-customization": nativeCommandResultSchemas["customization-validation"],
  "activate-customization": nativeCommandResultSchemas["customization-activation"],
  "rollback-customization": nativeCommandResultSchemas["customization-state"],
  "use-factory-customization": nativeCommandResultSchemas["customization-state"],
  "list-plugins": nativeCommandResultSchemas["plugins-listed"],
  "set-plugin-enabled": nativeCommandResultSchemas["plugins-listed"],
  "set-active-scene": nativeCommandResultSchemas["plugins-listed"],
  "delete-plugin": nativeCommandResultSchemas["plugins-listed"],
  "compile-inline-widget": nativeCommandResultSchemas["inline-widget-compiled"],
  "repair-inline-widget": nativeCommandResultSchemas["inline-widget-repaired"],
  "open-plugin-agent": nativeCommandResultSchemas["plugin-agent-snapshot"],
  "prompt-plugin-agent": nativeCommandResultSchemas["plugin-agent-snapshot"],
  "abort-plugin-agent": nativeCommandResultSchemas["plugin-agent-snapshot"],
  "detach-plugin-agent": nativeCommandResultSchemas["plugin-agent-detached"],
  "run-plugin-completion": nativeCommandResultSchemas["plugin-completion-result"],
  "cancel-plugin-completion": nativeCommandResultSchemas.accepted,
  "load-plugin-state": nativeCommandResultSchemas["plugin-state"],
  "save-plugin-state": nativeCommandResultSchemas["plugin-state"],
  "call-plugin-backend": nativeCommandResultSchemas["plugin-backend-result"],
  "cancel-plugin-backend-call": nativeCommandResultSchemas.accepted,
  "customization-rendered": nativeCommandResultSchemas["customization-state"],
  "customization-runtime-failed": nativeCommandResultSchemas["customization-state"],
} as const;

export type NativeCommandType =
  | "choose-project"
  | "open-external-url"
  | "show-transcript-selection-context-menu"
  | "show-composer-context-menu"
  | "show-session-context-menu"
  | "show-project-context-menu"
  | "choose-attachments"
  | "suggest-files"
  | "read-workspace-file"
  | "reword-composer-selection"
  | "generate-session-title"
  | "set-utility-model"
  | "register-project"
  | "rename-project"
  | "remove-project"
  | "delete-session"
  | "set-session-unread"
  | "restart-pi"
  | "create-worktree"
  | "get-worktree-status"
  | "land-worktree"
  | "open-terminal"
  | "get-terminal-status"
  | "get-embedded-editor-state"
  | "set-vscode-server-path"
  | "respond-artifact"
  | "respond-ui"
  | "export-artifacts"
  | "get-customization-state"
  | "get-plugin-authoring-reference"
  | "list-plugin-files"
  | "create-plugin"
  | "read-plugin-file"
  | "write-plugin-file"
  | "validate-customization"
  | "activate-customization"
  | "rollback-customization"
  | "use-factory-customization"
  | "list-plugins"
  | "set-plugin-enabled"
  | "set-active-scene"
  | "delete-plugin"
  | "compile-inline-widget"
  | "repair-inline-widget"
  | "open-plugin-agent"
  | "prompt-plugin-agent"
  | "abort-plugin-agent"
  | "detach-plugin-agent"
  | "run-plugin-completion"
  | "cancel-plugin-completion"
  | "load-plugin-state"
  | "save-plugin-state"
  | "call-plugin-backend"
  | "cancel-plugin-backend-call"
  | "customization-rendered"
  | "customization-runtime-failed"
  | "set-fullscreen-surface-open"
  | "inspect-workspace"
  | "respond-workspace-trust"
  | "discard-worktree"
  | "write-terminal"
  | "resize-terminal"
  | "close-terminal"
  | "install-embedded-editor"
  | "open-embedded-editor"
  | "update-embedded-editor-bounds"
  | "reveal-in-embedded-editor"
  | "open-embedded-editor-source-control"
  | "update-embedded-editor-annotations";

export type NativeEvent = typeof nativeEventSchema.Type;
export type NativeCommand = typeof nativeCommandSchema.Type;
export type NativeCommandResult = typeof nativeCommandResultSchema.Type;
