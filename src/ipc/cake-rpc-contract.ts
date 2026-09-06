import { Schema } from "effect";
import { artifactRecordSchema } from "./artifact-contract";
import { ipcProjectionArray, ipcProjectionString } from "./projection";
import { sourceLocationSchema } from "./source-location";
import { editorAnnotationSnapshotSchema } from "./editor-annotation";
import {
  compiledInlineWidgetSchema,
  inlineWidgetCapabilitySchema,
  inlineWidgetLanguageSchema,
  inlineWidgetSourceSchema,
  repairedInlineWidgetSchema,
} from "./inline-widget-contract";
import { jsonValueSchema } from "./json-contract";
import { ProjectSettings } from "../domain/application-data";
import { ProjectSessionControlRequest } from "../domain/project-session-data";
import {
  applicationStateSchema,
  attachmentSchema,
  extensionUiIntentSchema,
  fileSuggestionSchema,
  slashCommandSchema,
  utilityModelSchema,
} from "./session-contract";
import {
  worktreeLandOutcomeSchema,
  worktreeLandRequestSchema,
  worktreeRebaseOutcomeSchema,
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
  "renderer-events-ready": Schema.Struct({
    type: Schema.Literal("renderer-events-ready"),
    channel: Schema.Literals(["application", "artifacts", "terminals", "vscode", "surfaces"]),
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
  notification: Schema.Struct({
    type: Schema.Literal("notification"),
    tone: Schema.Literals(["info", "warning", "error"]),
    title: ipcProjectionString(256),
    message: ipcProjectionString(2_048),
  }),
  "extension-ui-intent": Schema.Struct({
    type: Schema.Literal("extension-ui-intent"),
    sessionId: stringMax(256),
    intent: extensionUiIntentSchema,
  }),
  "project-session-control-requested": ProjectSessionControlRequest.pipe(
    Schema.fieldsAssign({ type: Schema.Literal("project-session-control-requested") }),
  ),
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
  "embedded-editor-toggle-mode-requested": Schema.Struct({
    type: Schema.Literal("embedded-editor-toggle-mode-requested"),
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
  "embedded-editor-toggle-sidebar": Schema.Struct({
    type: Schema.Literal("embedded-editor-toggle-sidebar"),
    workspacePath: stringMax(4_096),
  }),
  "embedded-editor-selection-cleared": Schema.Struct({
    type: Schema.Literal("embedded-editor-selection-cleared"),
    workspacePath: stringMax(4_096),
  }),
  "embedded-editor-entered": Schema.Struct({
    type: Schema.Literal("embedded-editor-entered"),
    workspacePath: stringMax(4_096),
  }),
} as const;

export const applicationEventSchema = Schema.Union([
  cakeEventSchemas["renderer-events-ready"],
  cakeEventSchemas["workspace-inspected"],
  cakeEventSchemas["changelog-snapshot"],
  cakeEventSchemas.complete,
  cakeEventSchemas.fatal,
  cakeEventSchemas.notification,
  cakeEventSchemas["extension-ui-intent"],
  cakeEventSchemas["project-session-control-requested"],
]);

export const artifactEventSchema = Schema.Union([
  cakeEventSchemas["renderer-events-ready"],
  cakeEventSchemas["artifact-updated"],
  cakeEventSchemas["artifact-requested"],
  cakeEventSchemas["ui-request"],
]);

export const terminalEventSchema = Schema.Union([
  cakeEventSchemas["renderer-events-ready"],
  cakeEventSchemas["terminal-data"],
  cakeEventSchemas["terminal-exited"],
  cakeEventSchemas["terminal-toggle-requested"],
]);

export const embeddedEditorEventSchema = Schema.Union([
  cakeEventSchemas["renderer-events-ready"],
  cakeEventSchemas["embedded-editor-toggle-mode-requested"],
  cakeEventSchemas["embedded-editor-selection"],
  cakeEventSchemas["embedded-editor-back-to-agent"],
  cakeEventSchemas["embedded-editor-annotation-opened"],
  cakeEventSchemas["embedded-editor-toggle-chat"],
  cakeEventSchemas["embedded-editor-toggle-sidebar"],
  cakeEventSchemas["embedded-editor-selection-cleared"],
  cakeEventSchemas["embedded-editor-entered"],
]);

export const surfaceEventSchema = Schema.Union([
  cakeEventSchemas["renderer-events-ready"],
  cakeEventSchemas["fullscreen-surface-close-requested"],
]);

export const cakeEventSchema = Schema.Union([
  cakeEventSchemas["renderer-events-ready"],
  cakeEventSchemas["fullscreen-surface-close-requested"],
  cakeEventSchemas["workspace-inspected"],
  cakeEventSchemas["changelog-snapshot"],
  cakeEventSchemas["artifact-updated"],
  cakeEventSchemas["artifact-requested"],
  cakeEventSchemas["ui-request"],
  cakeEventSchemas["complete"],
  cakeEventSchemas["fatal"],
  cakeEventSchemas["notification"],
  cakeEventSchemas["extension-ui-intent"],
  cakeEventSchemas["project-session-control-requested"],
  cakeEventSchemas["terminal-data"],
  cakeEventSchemas["terminal-exited"],
  cakeEventSchemas["terminal-toggle-requested"],
  cakeEventSchemas["embedded-editor-toggle-mode-requested"],
  cakeEventSchemas["embedded-editor-selection"],
  cakeEventSchemas["embedded-editor-back-to-agent"],
  cakeEventSchemas["embedded-editor-annotation-opened"],
  cakeEventSchemas["embedded-editor-toggle-chat"],
  cakeEventSchemas["embedded-editor-toggle-sidebar"],
  cakeEventSchemas["embedded-editor-selection-cleared"],
  cakeEventSchemas["embedded-editor-entered"],
]);

const terminalTarget = Schema.Struct({
  workingDirectory: bounded(1, 4_096),
});

export const cakeRpcPayloadSchemas = {
  "choose-project": Schema.Struct({}),
  "open-external-url": Schema.Struct({
    url: stringMax(8_192),
  }),
  "show-notification": Schema.Struct({
    title: bounded(1, 256),
    body: bounded(1, 2_000),
    level: Schema.Literals(["info", "success", "warning", "error"]),
    id: Schema.optionalKey(bounded(1, 512)),
    groupId: Schema.optionalKey(bounded(1, 512)),
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
    familyChild: Schema.optional(Schema.Boolean),
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
    workingDirectory: bounded(1, 4_096),
  }),
  "close-terminal": Schema.Struct({
    ...requestBase,
    terminalId: uuid,
  }),
  "close-working-directory-terminals": Schema.Struct({
    ...requestBase,
    workingDirectory: bounded(1, 4_096),
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
    projectSidebarWidth: Schema.Number.check(
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
  "set-project-settings": Schema.Struct({
    path: bounded(1, 4_096),
    settings: ProjectSettings,
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
  "prepare-worktree-landing": Schema.Struct({
    ...requestBase,
    workspacePath: stringMax(4_096),
  }),
  "land-worktree": Schema.Struct({
    ...requestBase,
    workspacePath: stringMax(4_096),
    request: worktreeLandRequestSchema,
  }),
  "cancel-worktree-landing": Schema.Struct({
    ...requestBase,
    workspacePath: stringMax(4_096),
    landingOperationId: uuid,
  }),
  "rebase-worktree": Schema.Struct({
    ...requestBase,
    workspacePath: stringMax(4_096),
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
  "notification-shown": Schema.Struct({}),
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
    action: Schema.optional(
      Schema.Literals(["settings", "remove-project", "delete-resolved-worktrees"]),
    ),
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
    runningProgramCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
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
  "worktree-rebased": Schema.Struct({
    ...requestBase,
    result: worktreeRebaseOutcomeSchema,
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
  "show-notification": cakeRpcResultSchemas["notification-shown"],
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
  "set-project-settings": cakeRpcResultSchemas["application-state-updated"],
  "remove-project": cakeRpcResultSchemas["application-state-updated"],
  "delete-session": cakeRpcResultSchemas["application-state-updated"],
  "set-session-unread": cakeRpcResultSchemas["application-state-updated"],
  "restart-pi": cakeRpcResultSchemas.accepted,
  "inspect-workspace": cakeRpcResultSchemas.accepted,
  "respond-workspace-trust": cakeRpcResultSchemas.accepted,
  "create-worktree": cakeRpcResultSchemas["worktree-created"],
  "get-worktree-status": cakeRpcResultSchemas["worktree-status-loaded"],
  "prepare-worktree-landing": cakeRpcResultSchemas.accepted,
  "land-worktree": cakeRpcResultSchemas["worktree-landed"],
  "cancel-worktree-landing": cakeRpcResultSchemas.accepted,
  "rebase-worktree": cakeRpcResultSchemas["worktree-rebased"],
  "discard-worktree": cakeRpcResultSchemas.accepted,
  "open-terminal": cakeRpcResultSchemas["terminal-opened"],
  "write-terminal": cakeRpcResultSchemas.accepted,
  "resize-terminal": cakeRpcResultSchemas.accepted,
  "get-terminal-status": cakeRpcResultSchemas["terminal-status"],
  "close-terminal": cakeRpcResultSchemas.accepted,
  "close-working-directory-terminals": cakeRpcResultSchemas.accepted,
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
  "compile-inline-widget": cakeRpcResultSchemas["inline-widget-compiled"],
  "repair-inline-widget": cakeRpcResultSchemas["inline-widget-repaired"],
} as const;

export type CakeRpcOperation = keyof typeof cakeRpcPayloadSchemas;
export type CakeEvent = typeof cakeEventSchema.Type;
