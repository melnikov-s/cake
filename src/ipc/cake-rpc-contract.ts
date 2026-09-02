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
  fileSuggestionSchema,
  slashCommandSchema,
  utilityModelSchema,
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
const accepted = Schema.Struct({ requestId: uuid });

const cakeEventSchemas = {
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
  cakeEventSchemas["workspace-inspected"],
  cakeEventSchemas["changelog-snapshot"],
  cakeEventSchemas.complete,
  cakeEventSchemas.fatal,
  cakeEventSchemas.notification,
]);

export const artifactEventSchema = Schema.Union([
  cakeEventSchemas["artifact-updated"],
  cakeEventSchemas["artifact-requested"],
  cakeEventSchemas["ui-request"],
]);

export const pluginEventSchema = Schema.Union([
  cakeEventSchemas["plugin-backend-event"],
  cakeEventSchemas["plugin-agent-event"],
]);

export const terminalEventSchema = Schema.Union([
  cakeEventSchemas["terminal-data"],
  cakeEventSchemas["terminal-exited"],
  cakeEventSchemas["terminal-toggle-requested"],
]);

export const embeddedEditorEventSchema = Schema.Union([
  cakeEventSchemas["embedded-editor-selection"],
  cakeEventSchemas["embedded-editor-back-to-agent"],
  cakeEventSchemas["embedded-editor-annotation-opened"],
  cakeEventSchemas["embedded-editor-toggle-chat"],
  cakeEventSchemas["embedded-editor-selection-cleared"],
  cakeEventSchemas["embedded-editor-location-opened"],
]);

export const surfaceEventSchema = cakeEventSchemas["fullscreen-surface-close-requested"];

export const cakeEventSchema = Schema.Union([
  cakeEventSchemas["fullscreen-surface-close-requested"],
  cakeEventSchemas["workspace-inspected"],
  cakeEventSchemas["changelog-snapshot"],
  cakeEventSchemas["artifact-updated"],
  cakeEventSchemas["artifact-requested"],
  cakeEventSchemas["ui-request"],
  cakeEventSchemas["complete"],
  cakeEventSchemas["fatal"],
  cakeEventSchemas["plugin-backend-event"],
  cakeEventSchemas["notification"],
  cakeEventSchemas["plugin-agent-event"],
  cakeEventSchemas["terminal-data"],
  cakeEventSchemas["terminal-exited"],
  cakeEventSchemas["terminal-toggle-requested"],
  cakeEventSchemas["embedded-editor-selection"],
  cakeEventSchemas["embedded-editor-back-to-agent"],
  cakeEventSchemas["embedded-editor-annotation-opened"],
  cakeEventSchemas["embedded-editor-toggle-chat"],
  cakeEventSchemas["embedded-editor-selection-cleared"],
  cakeEventSchemas["embedded-editor-location-opened"],
]);

const terminalTarget = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("project"),
    sessionId: bounded(1, 256),
    workspacePath: bounded(1, 4_096),
  }),
  Schema.Struct({ kind: Schema.Literal("cake-chat"), sessionId: bounded(1, 256) }),
]);

export const cakeRpcPayloadSchemas = {
  "choose-project": Schema.Struct({}),
  "open-external-url": Schema.Struct({
    url: stringMax(8_192),
  }),
  "show-transcript-selection-context-menu": Schema.Struct({
    canChat: Schema.Boolean,
    canAnnotate: Schema.Boolean,
  }),
  "set-fullscreen-surface-open": Schema.Struct({
    ...requestBase,
    surfaceId: uuid,
    open: Schema.Boolean,
  }),
  "show-composer-context-menu": Schema.Struct({
    selection: bounded(1, 32_000),
    x: coordinate,
    y: coordinate,
  }),
  "reword-composer-selection": Schema.Struct({
    selection: bounded(1, 32_000),
    prompt: Schema.optional(stringMax(4_096)),
    workspacePath: Schema.optional(bounded(1, 4_096)),
  }),
  "generate-session-title": Schema.Struct({
    firstUserMessage: bounded(1, 262_144),
  }),
  "show-session-context-menu": Schema.Struct({
    sessionId: bounded(1, 256),
    x: coordinate,
    y: coordinate,
    resolved: Schema.Boolean,
    unread: Schema.optional(Schema.Boolean),
  }),
  "show-project-context-menu": Schema.Struct({
    path: bounded(1, 4_096),
    x: coordinate,
    y: coordinate,
    resolvedWorktreeCount: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 500 })),
  }),
  "open-terminal": Schema.Struct({
    ...requestBase,
    target: terminalTarget,
    cols: Schema.Int.check(Schema.isBetween({ minimum: 2, maximum: 1_000 })),
    rows: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1_000 })),
  }),
  "write-terminal": Schema.Struct({
    ...requestBase,
    terminalId: uuid,
    data: stringMax(262_144),
  }),
  "resize-terminal": Schema.Struct({
    ...requestBase,
    terminalId: uuid,
    cols: Schema.Int.check(Schema.isBetween({ minimum: 2, maximum: 1_000 })),
    rows: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1_000 })),
  }),
  "get-terminal-status": Schema.Struct({
    ...requestBase,
    terminalId: uuid,
  }),
  "close-terminal": Schema.Struct({
    ...requestBase,
    terminalId: uuid,
  }),
  "set-vscode-server-path": Schema.Struct({
    path: Schema.optional(stringMax(4_096)),
  }),
  "get-embedded-editor-state": Schema.Struct({}),
  "install-embedded-editor": Schema.Struct({
    ...requestBase,
  }),
  "open-embedded-editor": Schema.Struct({
    ...requestBase,
    workspacePath: stringMax(4_096),
  }),
  "update-embedded-editor-bounds": Schema.Struct({
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
    ...requestBase,
    workspacePath: stringMax(4_096),
    location: sourceLocationSchema,
  }),
  "open-embedded-editor-source-control": Schema.Struct({
    ...requestBase,
    workspacePath: stringMax(4_096),
  }),
  "update-embedded-editor-annotations": Schema.Struct({
    ...requestBase,
    workspacePath: stringMax(4_096),
    snapshot: editorAnnotationSnapshotSchema,
  }),
  "get-customization-state": Schema.Struct({}),
  "get-plugin-authoring-reference": Schema.Struct({}),
  "list-plugin-files": Schema.Struct({}),
  "create-plugin": Schema.Struct({
    pluginId: pluginIdSchema,
    name: Schema.Trim.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(128))),
    renderer: Schema.Boolean,
    backend: Schema.Boolean,
    scene: Schema.Boolean,
    expectedWorkingRevision: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  }),
  "read-plugin-file": Schema.Struct({
    pluginId: pluginIdSchema,
    path: bounded(1, 8_192),
  }),
  "write-plugin-file": Schema.Struct({
    pluginId: pluginIdSchema,
    path: bounded(1, 8_192),
    content: stringMax(2_000_000),
    expectedWorkingRevision: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  }),
  "validate-customization": Schema.Struct({
    expectedBaseRevision: Schema.optional(Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))),
    expectedSourceRevision: Schema.optional(
      Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
    ),
    request: Schema.optional(ipcProjectionString(8_192)),
  }),
  "activate-customization": Schema.Struct({
    revision: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
    expectedSourceRevision: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
    request: Schema.optional(ipcProjectionString(8_192)),
  }),
  "customization-rendered": Schema.Struct({
    revision: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  }),
  "customization-runtime-failed": Schema.Struct({
    revision: Schema.optional(Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))),
    message: ipcProjectionString(32_768),
  }),
  "rollback-customization": Schema.Struct({}),
  "use-factory-customization": Schema.Struct({}),
  "list-plugins": Schema.Struct({}),
  "set-plugin-enabled": Schema.Struct({
    pluginId: pluginIdSchema,
    enabled: Schema.Boolean,
  }),
  "set-active-scene": Schema.Struct({
    pluginId: Schema.optional(pluginIdSchema),
  }),
  "delete-plugin": Schema.Struct({
    pluginId: pluginIdSchema,
  }),
  "call-plugin-backend": Schema.Struct({
    pluginId: pluginIdSchema,
    callId: uuid,
    method: Schema.String.check(
      Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
      Schema.isMaxLength(256),
    ),
    input: jsonValueSchema,
  }),
  "cancel-plugin-backend-call": Schema.Struct({
    pluginId: pluginIdSchema,
    callId: uuid,
  }),
  "open-plugin-agent": Schema.Struct({
    pluginId: pluginIdSchema,
    options: pluginAgentOpenOptionsSchema,
    implicitSession: Schema.optional(sessionRefSchema),
  }),
  "prompt-plugin-agent": Schema.Struct({
    pluginId: pluginIdSchema,
    handleId: uuid,
    delivery: Schema.Literals(["prompt", "steer", "follow-up"]),
    text: bounded(1, 262_144),
  }),
  "abort-plugin-agent": Schema.Struct({
    pluginId: pluginIdSchema,
    handleId: uuid,
  }),
  "detach-plugin-agent": Schema.Struct({
    pluginId: pluginIdSchema,
    handleId: uuid,
  }),
  "run-plugin-completion": Schema.Struct({
    pluginId: pluginIdSchema,
    ...requestBase,
    request: pluginCompletionRequestSchema,
    implicitSession: Schema.optional(sessionRefSchema),
  }),
  "cancel-plugin-completion": Schema.Struct({
    pluginId: pluginIdSchema,
    ...requestBase,
  }),
  "load-plugin-state": Schema.Struct({
    pluginId: pluginIdSchema,
    key: pluginPersistenceKeySchema,
    scope: pluginPersistenceScopeSchema,
  }),
  "save-plugin-state": Schema.Struct({
    pluginId: pluginIdSchema,
    key: pluginPersistenceKeySchema,
    scope: pluginPersistenceScopeSchema,
    value: Schema.Json,
    expectedVersion: Schema.optional(nonNegativeInt),
  }),
  "choose-attachments": Schema.Struct({}),
  "suggest-files": Schema.Struct({
    workspacePath: stringMax(4_096),
    prefix: stringMax(4_096),
  }),
  "read-workspace-file": Schema.Struct({
    workspacePath: stringMax(4_096),
    path: bounded(1, 8_192),
  }),
  "compile-inline-widget": Schema.Struct({
    language: inlineWidgetLanguageSchema,
    capability: inlineWidgetCapabilitySchema,
    source: inlineWidgetSourceSchema,
  }),
  "repair-inline-widget": Schema.Struct({
    sessionId: bounded(1, 256),
    language: inlineWidgetLanguageSchema,
    capability: inlineWidgetCapabilitySchema,
    source: inlineWidgetSourceSchema,
    context: stringMax(262_144),
    diagnostic: Schema.optional(stringMax(32_768)),
    model: Schema.optional(Schema.Struct({ provider: bounded(1, 256), id: bounded(1, 512) })),
  }),
  "set-utility-model": Schema.Struct({
    model: Schema.optional(utilityModelSchema),
  }),
  "load-staged-slash-commands": Schema.Struct({
    path: stringMax(4_096),
  }),
  "register-project": Schema.Struct({
    path: stringMax(4_096),
    name: bounded(1, 512),
  }),
  "rename-project": Schema.Struct({
    path: stringMax(4_096),
    name: bounded(1, 512),
  }),
  "remove-project": Schema.Struct({
    path: stringMax(4_096),
    deleteSessions: Schema.Boolean,
  }),
  "delete-session": Schema.Struct({
    sessionId: bounded(1, 256),
  }),
  "set-session-unread": Schema.Struct({
    sessionId: bounded(1, 256),
    unread: Schema.Boolean,
  }),
  "restart-pi": Schema.Struct({ path: stringMax(4_096) }),
  "create-worktree": Schema.Struct({
    ...requestBase,
    path: stringMax(4_096),
    baseWorktreePath: Schema.optional(bounded(1, 4_096)),
    worktreeName: Schema.optional(
      Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,62}$/)),
    ),
    firstUserMessage: Schema.optional(bounded(1, 262_144)),
  }),
  "get-worktree-status": Schema.Struct({
    workspacePath: stringMax(4_096),
  }),
  "land-worktree": Schema.Struct({
    ...requestBase,
    workspacePath: stringMax(4_096),
    request: worktreeLandRequestSchema,
  }),
  "discard-worktree": Schema.Struct({
    ...requestBase,
    workspacePath: stringMax(4_096),
    keepBranch: Schema.Boolean,
  }),
  "inspect-workspace": Schema.Struct({
    ...requestBase,
    path: stringMax(4_096),
  }),
  "respond-workspace-trust": Schema.Struct({
    ...requestBase,
    path: stringMax(4_096),
    approved: Schema.Boolean,
  }),
  "respond-artifact": Schema.Struct({
    ...requestBase,
    artifactRequestId: uuid,
    sessionId: stringMax(256),
    value: Schema.optional(jsonValueSchema),
    cancelled: Schema.Boolean,
  }),
  "export-artifacts": Schema.Struct({
    sessionId: stringMax(256),
  }),
  "respond-ui": Schema.Struct({
    ...requestBase,
    uiRequestId: uuid,
    value: Schema.optional(stringMax(262_144)),
    cancelled: Schema.Boolean,
    sessionId: stringMax(256),
  }),
} as const;

const cakeRpcResultSchemas = {
  "project-chosen": Schema.Struct({
    path: Schema.optional(stringMax(4_096)),
  }),
  "external-url-opened": Schema.Struct({}),
  "transcript-selection-context-menu-closed": Schema.Struct({
    action: Schema.optional(Schema.Literals(["chat-about-selection", "add-annotation"])),
  }),
  "composer-context-menu-closed": Schema.Struct({
    action: Schema.optional(Schema.Literals(["reword", "reword-with-prompt"])),
  }),
  "composer-selection-reworded": Schema.Struct({
    text: bounded(1, 32_000),
  }),
  "session-title-generated": Schema.Struct({
    title: Schema.optional(bounded(1, 80)),
  }),
  "session-context-menu-closed": Schema.Struct({
    action: Schema.optional(
      Schema.Literals(["rename", "mark-unread", "resolve", "unresolve", "delete"]),
    ),
  }),
  "project-context-menu-closed": Schema.Struct({
    action: Schema.optional(Schema.Literals(["remove-project", "delete-resolved-worktrees"])),
  }),
  "embedded-editor-state-loaded": Schema.Struct({
    status: Schema.Literals(["missing", "downloading", "starting", "ready", "failed"]),
    message: Schema.optional(ipcProjectionString(4_096)),
    customPath: Schema.optional(stringMax(4_096)),
  }),
  "terminal-opened": Schema.Struct({
    ...requestBase,
    terminalId: uuid,
    shell: bounded(1, 256),
  }),
  "terminal-status": Schema.Struct({
    ...requestBase,
    runningProgram: Schema.Boolean,
  }),
  "customization-state": Schema.Struct({
    state: customizationStateSchema,
  }),
  "plugin-authoring-reference": Schema.Struct({
    reference: stringMax(1_000_000),
  }),
  "plugin-files": Schema.Struct({
    workingRevision: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
    buildRevision: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
    files: Schema.Array(bounded(1, 8_192)).check(Schema.isMaxLength(100_000)),
  }),
  "plugin-file": Schema.Struct({
    pluginId: pluginIdSchema,
    path: bounded(1, 8_192),
    content: stringMax(2_000_000),
  }),
  "customization-validation": Schema.Struct({
    revision: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
    sourceRevision: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
    diagnostics: Schema.Array(pluginDiagnosticSchema).check(Schema.isMaxLength(1_000)),
    valid: Schema.Boolean,
  }),
  "customization-activation": Schema.Struct({
    revision: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
    activating: Schema.Literal(true),
  }),
  "plugin-state": Schema.Struct({
    record: Schema.optional(pluginPersistenceRecordSchema),
  }),
  "plugins-listed": Schema.Struct({
    plugins: Schema.Array(pluginStatusSchema).check(Schema.isMaxLength(1_000)),
  }),
  "plugin-backend-result": Schema.Struct({
    callId: uuid,
    ok: Schema.Boolean,
    value: Schema.optional(jsonValueSchema),
    error: Schema.optional(ipcProjectionString(32_768)),
  }),
  "plugin-agent-snapshot": Schema.Struct({
    snapshot: pluginAgentSnapshotSchema,
  }),
  "plugin-agent-detached": Schema.Struct({
    handleId: uuid,
  }),
  "plugin-completion-result": Schema.Struct({
    requestId: uuid,
    result: pluginCompletionResultSchema,
  }),
  "attachments-chosen": Schema.Struct({
    attachments: Schema.Array(attachmentSchema).check(Schema.isMaxLength(20)),
  }),
  "file-suggestions": Schema.Struct({
    suggestions: Schema.Array(fileSuggestionSchema).check(Schema.isMaxLength(20)),
  }),
  "workspace-file": Schema.Struct({
    content: stringMax(2_000_000),
  }),
  "inline-widget-compiled": Schema.Struct({
    widget: compiledInlineWidgetSchema,
  }),
  "inline-widget-repaired": Schema.Struct({
    widget: repairedInlineWidgetSchema,
  }),
  "application-state-updated": Schema.Struct({
    state: applicationStateSchema,
  }),
  "slash-commands-loaded": Schema.Struct({
    commands: ipcProjectionArray(slashCommandSchema, 20_000),
  }),
  "worktree-created": Schema.Struct({
    ...requestBase,
    record: worktreeRecordSchema,
  }),
  "worktree-status-loaded": Schema.Struct({
    status: Schema.optional(worktreeStatusSchema),
  }),
  "worktree-landed": Schema.Struct({
    ...requestBase,
    result: worktreeLandOutcomeSchema,
  }),
  accepted: accepted,
  "ui-response-accepted": Schema.Struct({
    uiRequestId: uuid,
  }),
  "artifact-response-accepted": Schema.Struct({
    artifactRequestId: uuid,
  }),
  "artifacts-exported": Schema.Struct({
    markdown: stringMax(20_000_000),
  }),
} as const;

export const cakeRpcSuccessSchemas = {
  "choose-project": cakeRpcResultSchemas["project-chosen"],
  "open-external-url": cakeRpcResultSchemas["external-url-opened"],
  "show-transcript-selection-context-menu":
    cakeRpcResultSchemas["transcript-selection-context-menu-closed"],
  "show-composer-context-menu": cakeRpcResultSchemas["composer-context-menu-closed"],
  "show-session-context-menu": cakeRpcResultSchemas["session-context-menu-closed"],
  "show-project-context-menu": cakeRpcResultSchemas["project-context-menu-closed"],
  "set-fullscreen-surface-open": cakeRpcResultSchemas.accepted,
  "choose-attachments": cakeRpcResultSchemas["attachments-chosen"],
  "suggest-files": cakeRpcResultSchemas["file-suggestions"],
  "read-workspace-file": cakeRpcResultSchemas["workspace-file"],
  "reword-composer-selection": cakeRpcResultSchemas["composer-selection-reworded"],
  "generate-session-title": cakeRpcResultSchemas["session-title-generated"],
  "set-utility-model": cakeRpcResultSchemas["application-state-updated"],
  "load-staged-slash-commands": cakeRpcResultSchemas["slash-commands-loaded"],
  "register-project": cakeRpcResultSchemas["application-state-updated"],
  "rename-project": cakeRpcResultSchemas["application-state-updated"],
  "remove-project": cakeRpcResultSchemas["application-state-updated"],
  "delete-session": cakeRpcResultSchemas["application-state-updated"],
  "set-session-unread": cakeRpcResultSchemas["application-state-updated"],
  "restart-pi": cakeRpcResultSchemas.accepted,
  "inspect-workspace": cakeRpcResultSchemas.accepted,
  "respond-workspace-trust": cakeRpcResultSchemas.accepted,
  "create-worktree": cakeRpcResultSchemas["worktree-created"],
  "get-worktree-status": cakeRpcResultSchemas["worktree-status-loaded"],
  "land-worktree": cakeRpcResultSchemas["worktree-landed"],
  "discard-worktree": cakeRpcResultSchemas.accepted,
  "open-terminal": cakeRpcResultSchemas["terminal-opened"],
  "write-terminal": cakeRpcResultSchemas.accepted,
  "resize-terminal": cakeRpcResultSchemas.accepted,
  "get-terminal-status": cakeRpcResultSchemas["terminal-status"],
  "close-terminal": cakeRpcResultSchemas.accepted,
  "get-embedded-editor-state": cakeRpcResultSchemas["embedded-editor-state-loaded"],
  "install-embedded-editor": cakeRpcResultSchemas.accepted,
  "set-vscode-server-path": cakeRpcResultSchemas["application-state-updated"],
  "open-embedded-editor": cakeRpcResultSchemas.accepted,
  "update-embedded-editor-bounds": cakeRpcResultSchemas.accepted,
  "reveal-in-embedded-editor": cakeRpcResultSchemas.accepted,
  "open-embedded-editor-source-control": cakeRpcResultSchemas.accepted,
  "update-embedded-editor-annotations": cakeRpcResultSchemas.accepted,
  "respond-artifact": cakeRpcResultSchemas["artifact-response-accepted"],
  "respond-ui": cakeRpcResultSchemas["ui-response-accepted"],
  "export-artifacts": cakeRpcResultSchemas["artifacts-exported"],
  "get-customization-state": cakeRpcResultSchemas["customization-state"],
  "get-plugin-authoring-reference": cakeRpcResultSchemas["plugin-authoring-reference"],
  "list-plugin-files": cakeRpcResultSchemas["plugin-files"],
  "create-plugin": cakeRpcResultSchemas["plugin-files"],
  "read-plugin-file": cakeRpcResultSchemas["plugin-file"],
  "write-plugin-file": cakeRpcResultSchemas["plugin-files"],
  "validate-customization": cakeRpcResultSchemas["customization-validation"],
  "activate-customization": cakeRpcResultSchemas["customization-activation"],
  "rollback-customization": cakeRpcResultSchemas["customization-state"],
  "use-factory-customization": cakeRpcResultSchemas["customization-state"],
  "list-plugins": cakeRpcResultSchemas["plugins-listed"],
  "set-plugin-enabled": cakeRpcResultSchemas["plugins-listed"],
  "set-active-scene": cakeRpcResultSchemas["plugins-listed"],
  "delete-plugin": cakeRpcResultSchemas["plugins-listed"],
  "compile-inline-widget": cakeRpcResultSchemas["inline-widget-compiled"],
  "repair-inline-widget": cakeRpcResultSchemas["inline-widget-repaired"],
  "open-plugin-agent": cakeRpcResultSchemas["plugin-agent-snapshot"],
  "prompt-plugin-agent": cakeRpcResultSchemas["plugin-agent-snapshot"],
  "abort-plugin-agent": cakeRpcResultSchemas["plugin-agent-snapshot"],
  "detach-plugin-agent": cakeRpcResultSchemas["plugin-agent-detached"],
  "run-plugin-completion": cakeRpcResultSchemas["plugin-completion-result"],
  "cancel-plugin-completion": cakeRpcResultSchemas.accepted,
  "load-plugin-state": cakeRpcResultSchemas["plugin-state"],
  "save-plugin-state": cakeRpcResultSchemas["plugin-state"],
  "call-plugin-backend": cakeRpcResultSchemas["plugin-backend-result"],
  "cancel-plugin-backend-call": cakeRpcResultSchemas.accepted,
  "customization-rendered": cakeRpcResultSchemas["customization-state"],
  "customization-runtime-failed": cakeRpcResultSchemas["customization-state"],
} as const;

export type CakeRpcOperation = keyof typeof cakeRpcPayloadSchemas;
export type CakeEvent = typeof cakeEventSchema.Type;
