import { Effect, Schema } from "effect";
import {
  RendererApplicationState,
  UtilityModel as UtilityModelSchema,
  type ProjectRecord as ProjectRecordType,
} from "../domain/application/application-data";
import { artifactRecordSchema } from "./artifact-contract";
import { CrossSessionMessageMetadata } from "../domain/conversations/cross-session-coordination";
import { ScheduledMessageOrigin } from "../domain/scheduled-messages/scheduled-message-envelope";
import { ipcProjectionArray, ipcProjectionString } from "./projection";
import { sourceLocationSchema } from "./source-location";

export const SESSION_TITLE_MAX_LENGTH = 144;

const boundedText = ipcProjectionString(262_144);
const stringMax = (maximum: number) => Schema.String.check(Schema.isMaxLength(maximum));
const stringRange = (minimum: number, maximum: number) =>
  Schema.String.check(Schema.isMinLength(minimum), Schema.isMaxLength(maximum));
const nonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const positiveInt = Schema.Int.check(Schema.isGreaterThan(0));
const defaultKey = <S extends Schema.Top>(schema: S, value: S["Type"]) =>
  schema.pipe(Schema.withDecodingDefaultKey(Effect.succeed(value)));

export const thinkingLevelSchema = Schema.Literals([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

export const utilityModelSchema = UtilityModelSchema;

const piResourcePathSchema = stringRange(1, 4_096);
const piResourcePathsSchema = Schema.Array(piResourcePathSchema).check(Schema.isMaxLength(1_000));
const piPackageSourceSchema = Schema.Union([
  piResourcePathSchema,
  Schema.Struct({
    source: piResourcePathSchema,
    autoload: Schema.optional(Schema.Boolean),
    extensions: Schema.optional(piResourcePathsSchema),
    skills: Schema.optional(piResourcePathsSchema),
    prompts: Schema.optional(piResourcePathsSchema),
    themes: Schema.optional(piResourcePathsSchema),
  }),
]);

export const piSettingsSchema = Schema.Struct({
  defaultProvider: Schema.optional(stringMax(256)),
  defaultModel: Schema.optional(stringMax(512)),
  defaultThinkingLevel: Schema.optional(thinkingLevelSchema),
  autoCompact: Schema.Boolean,
  autoResizeImages: Schema.Boolean,
  blockImages: Schema.Boolean,
  enableSkillCommands: Schema.Boolean,
  steeringMode: Schema.Literals(["one-at-a-time", "all"]),
  followUpMode: Schema.Literals(["one-at-a-time", "all"]),
  transport: Schema.Literals(["sse", "websocket", "websocket-cached", "auto"]),
  httpIdleTimeoutMs: nonNegativeInt,
  hideThinkingBlock: Schema.Boolean,
  mermaidRenderingMode: Schema.Literals(["off", "final", "streaming"]),
  showCacheMissNotices: Schema.Boolean,
  collapseChangelog: Schema.Boolean,
  quietStartup: Schema.Boolean,
  enableInstallTelemetry: Schema.Boolean,
  defaultProjectTrust: Schema.Literals(["ask", "always", "never"]),
  doubleEscapeAction: Schema.Literals(["fork", "tree", "none"]),
  treeFilterMode: Schema.Literals(["default", "no-tools", "user-only", "labeled-only", "all"]),
  anthropicExtraUsageWarning: Schema.Boolean,
  retryEnabled: Schema.Boolean,
  shellPath: stringMax(4_096),
  shellCommandPrefix: stringMax(16_384),
  npmCommand: Schema.Array(stringMax(4_096)).check(Schema.isMaxLength(100)),
  packages: Schema.Array(piPackageSourceSchema).check(Schema.isMaxLength(1_000)),
  extensions: piResourcePathsSchema,
  skills: piResourcePathsSchema,
  prompts: piResourcePathsSchema,
  reloadPending: Schema.Boolean,
});

export const piSettingUpdateSchema = Schema.Union([
  Schema.Struct({
    key: Schema.Literal("defaultModel"),
    provider: stringRange(1, 256),
    modelId: stringRange(1, 512),
  }),
  Schema.Struct({ key: Schema.Literal("defaultThinkingLevel"), value: thinkingLevelSchema }),
  Schema.Struct({ key: Schema.Literal("autoCompact"), value: Schema.Boolean }),
  Schema.Struct({ key: Schema.Literal("autoResizeImages"), value: Schema.Boolean }),
  Schema.Struct({ key: Schema.Literal("blockImages"), value: Schema.Boolean }),
  Schema.Struct({ key: Schema.Literal("enableSkillCommands"), value: Schema.Boolean }),
  Schema.Struct({
    key: Schema.Literal("steeringMode"),
    value: Schema.Literals(["one-at-a-time", "all"]),
  }),
  Schema.Struct({
    key: Schema.Literal("followUpMode"),
    value: Schema.Literals(["one-at-a-time", "all"]),
  }),
  Schema.Struct({
    key: Schema.Literal("transport"),
    value: Schema.Literals(["sse", "websocket", "websocket-cached", "auto"]),
  }),
  Schema.Struct({ key: Schema.Literal("httpIdleTimeoutMs"), value: nonNegativeInt }),
  Schema.Struct({ key: Schema.Literal("hideThinkingBlock"), value: Schema.Boolean }),
  Schema.Struct({
    key: Schema.Literal("mermaidRenderingMode"),
    value: Schema.Literals(["off", "final", "streaming"]),
  }),
  Schema.Struct({ key: Schema.Literal("showCacheMissNotices"), value: Schema.Boolean }),
  Schema.Struct({ key: Schema.Literal("collapseChangelog"), value: Schema.Boolean }),
  Schema.Struct({ key: Schema.Literal("quietStartup"), value: Schema.Boolean }),
  Schema.Struct({ key: Schema.Literal("enableInstallTelemetry"), value: Schema.Boolean }),
  Schema.Struct({
    key: Schema.Literal("defaultProjectTrust"),
    value: Schema.Literals(["ask", "always", "never"]),
  }),
  Schema.Struct({
    key: Schema.Literal("doubleEscapeAction"),
    value: Schema.Literals(["fork", "tree", "none"]),
  }),
  Schema.Struct({
    key: Schema.Literal("treeFilterMode"),
    value: Schema.Literals(["default", "no-tools", "user-only", "labeled-only", "all"]),
  }),
  Schema.Struct({ key: Schema.Literal("anthropicExtraUsageWarning"), value: Schema.Boolean }),
  Schema.Struct({ key: Schema.Literal("retryEnabled"), value: Schema.Boolean }),
  Schema.Struct({ key: Schema.Literal("shellPath"), value: stringMax(4_096) }),
  Schema.Struct({ key: Schema.Literal("shellCommandPrefix"), value: stringMax(16_384) }),
  Schema.Struct({
    key: Schema.Literal("npmCommand"),
    value: Schema.Array(stringMax(4_096)).check(Schema.isMaxLength(100)),
  }),
  Schema.Struct({
    key: Schema.Literal("packages"),
    value: Schema.Array(piPackageSourceSchema).check(Schema.isMaxLength(1_000)),
  }),
  Schema.Struct({ key: Schema.Literal("extensions"), value: piResourcePathsSchema }),
  Schema.Struct({ key: Schema.Literal("skills"), value: piResourcePathsSchema }),
  Schema.Struct({ key: Schema.Literal("prompts"), value: piResourcePathsSchema }),
]);

export const fileSuggestionSchema = Schema.Struct({
  value: stringRange(1, 4_096),
  label: ipcProjectionString(512).check(Schema.isMinLength(1)),
  description: Schema.optional(ipcProjectionString(4_096)),
});

const annotationSchema = Schema.Struct({
  id: Schema.String.check(Schema.isUUID()),
  messageId: stringRange(1, 256),
  entryId: Schema.optionalKey(stringRange(1, 256)),
  selectedText: ipcProjectionString(48_000).check(Schema.isMinLength(1)),
  startOffset: nonNegativeInt,
  endOffset: nonNegativeInt,
  contextBefore: ipcProjectionString(8_000),
  contextAfter: ipcProjectionString(8_000),
  comment: Schema.optionalKey(ipcProjectionString(16_000)),
}).check(
  Schema.makeFilter((annotation) =>
    annotation.endOffset > annotation.startOffset
      ? undefined
      : "Annotation end offset must follow its start offset",
  ),
);

const sourceLineSchema = Schema.Struct({
  line: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(10_000_000)),
});
const sourceAttachmentLocationSchema = Schema.Struct({
  path: Schema.Trim.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(8_192))),
  range: Schema.Struct({ start: sourceLineSchema, end: sourceLineSchema }),
});

export const attachmentSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("file"), name: stringMax(512), path: stringMax(4_096) }),
  Schema.Struct({
    kind: Schema.Literal("image"),
    name: stringMax(512),
    mimeType: stringMax(128),
    data: stringMax(20_000_000),
  }),
  Schema.Struct({
    kind: Schema.Literal("source"),
    name: stringMax(512),
    location: sourceAttachmentLocationSchema,
  }),
  Schema.Struct({
    kind: Schema.Literal("annotation"),
    annotations: Schema.Array(annotationSchema).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(100),
    ),
  }),
]);

const partBase = { id: stringRange(1, 256) };
const toolOutputContentSchema = Schema.Union([
  Schema.Struct({ type: Schema.Literal("text"), text: boundedText }),
  Schema.Struct({
    type: Schema.Literal("image"),
    data: stringMax(20_000_000),
    mimeType: stringMax(128),
  }),
]);
export const toolOutputContentArraySchema = ipcProjectionArray(toolOutputContentSchema, 100);
export type ToolOutputContent = typeof toolOutputContentSchema.Type;

export const uiPartSchema = Schema.Union([
  Schema.Struct({
    ...partBase,
    kind: Schema.Literal("text"),
    role: Schema.Literals(["user", "assistant"]),
    entryId: Schema.optional(stringRange(1, 256)),
    text: boundedText,
    status: Schema.Literals(["streaming", "complete", "error"]),
    renderAs: Schema.optional(Schema.Literal("markdown")),
    deliveryState: Schema.optional(Schema.Literals(["sending", "queued", "steering"])),
    draft: Schema.optional(Schema.Boolean),
    crossSession: Schema.optional(CrossSessionMessageMetadata),
    scheduled: Schema.optional(ScheduledMessageOrigin),
  }),
  Schema.Struct({
    ...partBase,
    kind: Schema.Literal("skill"),
    entryId: Schema.optional(stringRange(1, 256)),
    name: ipcProjectionString(256),
    content: boundedText,
  }),
  Schema.Struct({
    ...partBase,
    kind: Schema.Literal("reasoning"),
    text: boundedText,
    status: Schema.Literals(["streaming", "complete"]),
  }),
  Schema.Struct({
    ...partBase,
    kind: Schema.Literal("command"),
    command: boundedText,
    output: boundedText,
    excludeFromContext: Schema.Boolean,
    state: Schema.Literals(["running", "success", "error"]),
  }),
  Schema.Struct({
    ...partBase,
    kind: Schema.Literal("tool"),
    name: ipcProjectionString(256),
    command: Schema.optional(ipcProjectionString(256)),
    input: boundedText,
    output: Schema.optional(boundedText),
    outputContent: Schema.optional(toolOutputContentArraySchema),
    artifactId: Schema.optional(stringRange(1, 256)),
    filePath: Schema.optional(stringMax(8_192)),
    diff: Schema.optional(boundedText),
    inputStreaming: Schema.optional(Schema.Boolean),
    state: Schema.Literals(["approval", "running", "success", "error", "denied", "interrupted"]),
  }),
  Schema.Struct({
    ...partBase,
    kind: Schema.Literal("source"),
    title: ipcProjectionString(1_024),
    url: stringMax(8_192),
  }),
  Schema.Struct({
    ...partBase,
    kind: Schema.Literal("attachment"),
    name: ipcProjectionString(512),
    mediaType: stringMax(128),
    attachmentKind: Schema.Literals(["file", "image", "source"]),
    data: Schema.optional(stringMax(20_000_000)),
    location: Schema.optional(sourceLocationSchema),
  }),
  Schema.Struct({
    ...partBase,
    kind: Schema.Literal("annotation"),
    annotations: Schema.Array(annotationSchema).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(100),
    ),
  }),
  Schema.Struct({
    ...partBase,
    kind: Schema.Literal("notice"),
    tone: Schema.Literals(["info", "warning", "error"]),
    title: ipcProjectionString(512),
    detail: Schema.optional(boundedText),
    retryAt: Schema.optional(nonNegativeInt),
  }),
  Schema.Struct({
    ...partBase,
    kind: Schema.Literal("review-run"),
    operationId: Schema.String.check(Schema.isUUID()),
    threadIds: Schema.Array(stringRange(1, 256)).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(100),
    ),
    commentCount: Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(1_000_000)),
    status: Schema.Literals(["running", "complete", "error"]),
  }),
  Schema.Struct({
    ...partBase,
    kind: Schema.Literal("compaction"),
    summary: boundedText,
    tokensBefore: nonNegativeInt,
    firstKeptEntryId: Schema.optional(stringRange(1, 256)),
  }),
]);

const modelOptionSchema = Schema.Struct({
  provider: stringMax(256),
  providerName: ipcProjectionString(512),
  id: stringMax(512),
  name: ipcProjectionString(1_024),
  reasoning: Schema.Boolean,
  availableThinkingLevels: ipcProjectionArray(thinkingLevelSchema, 7),
  fastMode: Schema.optional(Schema.Boolean),
  input: ipcProjectionArray(Schema.Literals(["text", "image"]), 2),
  authenticated: Schema.Boolean,
  available: Schema.optional(Schema.Boolean),
  authSource: Schema.optional(
    Schema.Literals([
      "stored",
      "runtime",
      "environment",
      "fallback",
      "models_json_key",
      "models_json_command",
    ]),
  ),
  authLabel: Schema.optional(ipcProjectionString(512)),
  authTypes: ipcProjectionArray(Schema.Literals(["api_key", "oauth"]), 2),
});

export const sessionUsageSchema = Schema.Struct({
  tokens: Schema.Struct({
    input: nonNegativeInt,
    output: nonNegativeInt,
    cacheRead: nonNegativeInt,
    cacheWrite: nonNegativeInt,
    total: nonNegativeInt,
  }),
  cost: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
  context: Schema.optional(
    Schema.Struct({
      tokens: Schema.NullOr(nonNegativeInt),
      contextWindow: positiveInt,
      percent: Schema.NullOr(Schema.Number.check(Schema.isGreaterThanOrEqualTo(0))),
    }),
  ),
});

const sessionTreeEntrySchema = Schema.Struct({
  id: stringRange(1, 256),
  parentId: Schema.optional(stringMax(256)),
  type: stringMax(128),
  messageRole: Schema.optional(stringMax(128)),
  editorText: Schema.optional(boundedText),
  label: Schema.optional(ipcProjectionString(512)),
  preview: ipcProjectionString(2_048),
  active: Schema.Boolean,
});

const resourceScopeSchema = Schema.Literals(["user", "project", "temporary"]);
const compatibilityResourceSchema = Schema.Struct({
  id: stringRange(1, 8_192),
  kind: Schema.Literals(["skill", "prompt", "package", "extension"]),
  name: ipcProjectionString(1_024).check(Schema.isMinLength(1)),
  description: Schema.optional(ipcProjectionString(4_096)),
  path: Schema.optional(stringMax(8_192)),
  source: ipcProjectionString(2_048),
  scope: resourceScopeSchema,
  origin: Schema.Literals(["package", "top-level"]),
  commands: defaultKey(ipcProjectionArray(stringMax(256), 1_000), []),
  tools: defaultKey(ipcProjectionArray(stringMax(256), 1_000), []),
  enabled: defaultKey(Schema.Boolean, true),
});
const resourceDiagnosticSchema = Schema.Struct({
  id: stringRange(1, 8_192),
  severity: Schema.Literals(["info", "warning", "error"]),
  source: Schema.Literals(["extension", "skill", "prompt", "package", "compatibility", "runtime"]),
  message: ipcProjectionString(4_096),
  path: Schema.optional(stringMax(8_192)),
  method: Schema.optional(ipcProjectionString(256)),
});
const compatibilityCatalogSchema = Schema.Struct({
  resources: defaultKey(ipcProjectionArray(compatibilityResourceSchema, 20_000), []),
  diagnostics: defaultKey(ipcProjectionArray(resourceDiagnosticSchema, 5_000), []),
});
const extensionNotificationSchema = Schema.Struct({
  id: stringRange(1, 256),
  message: ipcProjectionString(4_096),
  tone: Schema.Literals(["info", "warning", "error"]),
});
const extensionEditorTextSchema = Schema.Struct({
  text: ipcProjectionString(262_144),
  mode: Schema.Literals(["replace", "insert"]),
});
const extensionUiStateSchema = Schema.Struct({
  title: Schema.optional(ipcProjectionString(512)),
  statuses: defaultKey(
    ipcProjectionArray(
      Schema.Struct({ key: stringMax(256), text: ipcProjectionString(2_048) }),
      100,
    ),
    [],
  ),
});

export const slashCommandSchema = Schema.Struct({
  name: stringRange(1, 256),
  description: Schema.optional(ipcProjectionString(4_096)),
  argumentHint: Schema.optional(ipcProjectionString(512)),
  source: Schema.Literals(["builtin", "extension", "prompt", "skill"]),
  sourceInfo: Schema.Struct({
    path: stringMax(8_192),
    source: ipcProjectionString(2_048),
    scope: resourceScopeSchema,
    origin: Schema.Literals(["package", "top-level"]),
  }),
});

const builtinSourceInfo = {
  path: "builtin:pi-cli",
  source: "Pi CLI",
  scope: "temporary",
  origin: "top-level",
} as const;
const cakeBuiltinSourceInfo = {
  path: "builtin:cake",
  source: "Cake",
  scope: "temporary",
  origin: "top-level",
} as const;
export const piBuiltinSlashCommands = [
  { name: "compact", description: "Manually compact the session context" },
  { name: "model", description: "Switch model", argumentHint: "<provider/model>" },
  { name: "name", description: "Rename the current session" },
  {
    name: "sidechat",
    description: "Start a side chat",
    argumentHint: "<prompt>",
  },
  {
    name: "schedule",
    description: "Schedule a message to this session",
    argumentHint: "<10s|5m|2h|1d|ISO time> <message>",
  },
  {
    name: "toolcompact",
    description: "Compact tool activity while preserving the visible conversation",
    argumentHint: "[first instruction]",
  },
].map((command) =>
  Schema.decodeUnknownSync(slashCommandSchema)({
    ...command,
    source: "builtin",
    sourceInfo: command.name === "sidechat" ? cakeBuiltinSourceInfo : builtinSourceInfo,
  }),
);

/** Pi commands Cake can execute before a Pi Session Runtime exists. */
export const stagedSessionSlashCommands = piBuiltinSlashCommands.filter(
  (command) => command.name === "model" || command.name === "name",
);

export function parsePiBuiltinCommand(text: string): { name: string; args: string } | undefined {
  const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!match) return undefined;
  const name = match[1]!.toLocaleLowerCase();
  if (!piBuiltinSlashCommands.some((command) => command.name === name)) return undefined;
  return { name, args: match[2]?.trim() ?? "" };
}

export const extensionUiEventSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("status"),
    key: stringMax(256),
    text: Schema.optional(ipcProjectionString(2_048)),
  }),
  Schema.Struct({ kind: Schema.Literal("title"), title: ipcProjectionString(512) }),
  Schema.Struct({ kind: Schema.Literal("diagnostic"), diagnostic: resourceDiagnosticSchema }),
]);

export const extensionUiIntentSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("notify"), ...extensionNotificationSchema.fields }),
  Schema.Struct({ kind: Schema.Literal("editor-text"), ...extensionEditorTextSchema.fields }),
]);

export const sessionSnapshotSchema = Schema.Struct({
  workspacePath: stringMax(4_096),
  sessionId: stringRange(1, 256),
  sessionFile: stringMax(4_096),
  sessionListed: Schema.optional(Schema.Boolean),
  parts: ipcProjectionArray(uiPartSchema, 50_000),
  model: Schema.optional(
    Schema.Struct({ provider: Schema.String, id: Schema.String, name: Schema.String }),
  ),
  fastMode: Schema.optional(Schema.Boolean),
  fastModeAvailable: Schema.optional(Schema.Boolean),
  models: ipcProjectionArray(modelOptionSchema, 5_000),
  thinkingLevel: thinkingLevelSchema,
  availableThinkingLevels: ipcProjectionArray(thinkingLevelSchema, 7),
  piSettings: Schema.optional(piSettingsSchema),
  streaming: Schema.Boolean,
  diagnostics: ipcProjectionArray(ipcProjectionString(4_096), 1_000),
  commands: ipcProjectionArray(slashCommandSchema, 20_000),
  usage: Schema.optional(sessionUsageSchema),
  compatibility: defaultKey(compatibilityCatalogSchema, { resources: [], diagnostics: [] }),
  extensionUi: defaultKey(extensionUiStateSchema, { statuses: [] }),
  tree: defaultKey(ipcProjectionArray(sessionTreeEntrySchema, 50_000), []),
  artifacts: Schema.optional(ipcProjectionArray(artifactRecordSchema, 10_000)),
});

export const applicationStateSchema = RendererApplicationState;

export type WorkLogViewMode = "auto" | "diff" | "log";
export type WorkLogsExpansion = "collapsed" | "expanded" | "fully-expanded";
export type FileSuggestion = typeof fileSuggestionSchema.Type;
export type Annotation = typeof annotationSchema.Type;
export type Attachment = typeof attachmentSchema.Type;
export type UiPart = typeof uiPartSchema.Type;
export type ModelOption = typeof modelOptionSchema.Type;
export type ThinkingLevel = typeof thinkingLevelSchema.Type;
export type UtilityModel = typeof utilityModelSchema.Type;
export type SessionUsage = typeof sessionUsageSchema.Type;
export interface ModelPreset extends ChatConfiguration {
  readonly id: string;
  readonly name: string;
}
export interface ChatConfiguration {
  readonly provider: string;
  readonly modelId: string;
  readonly thinkingLevel: ThinkingLevel;
  readonly fastMode: boolean;
}
export type PiSettings = typeof piSettingsSchema.Type;
export type PiSettingUpdate = typeof piSettingUpdateSchema.Type;
export type SessionSnapshot = typeof sessionSnapshotSchema.Type;
export interface SessionPreview {
  readonly workspacePath: string;
  readonly sessionId: string;
  readonly sessionFile: string;
  readonly parts: ReadonlyArray<UiPart>;
  readonly currentModel?: { readonly provider: string; readonly modelId: string };
}
export interface SessionSummary {
  readonly id: string;
  readonly title: string;
  readonly created: string;
  readonly modified: string;
  readonly messageCount: number;
  readonly parentSessionId?: string;
  readonly resolved: boolean;
  readonly draft?: boolean;
}
export type SessionTreeEntry = typeof sessionTreeEntrySchema.Type;
export type CompatibilityResource = typeof compatibilityResourceSchema.Type;
export type ResourceDiagnostic = typeof resourceDiagnosticSchema.Type;
export type CompatibilityCatalog = typeof compatibilityCatalogSchema.Type;
export type ExtensionUiState = typeof extensionUiStateSchema.Type;
export type ExtensionUiEvent = typeof extensionUiEventSchema.Type;
export type ExtensionUiIntent = typeof extensionUiIntentSchema.Type;
export type ProjectRecord = ProjectRecordType;
export type ApplicationState = typeof applicationStateSchema.Type;
