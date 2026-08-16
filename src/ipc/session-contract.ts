import { z } from "zod";
import { artifactRecordSchema } from "./artifact-contract";
import { ipcProjectionArray, ipcProjectionString } from "./projection";

export const SESSION_TITLE_MAX_LENGTH = 1_024;

const boundedText = ipcProjectionString(262_144);

export const thinkingLevelSchema = z.enum([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max"
]);

const piResourcePathSchema = z.string().min(1).max(4_096);
const piResourcePathsSchema = z.array(piResourcePathSchema).max(1_000);
const piPackageSourceSchema = z.union([
  piResourcePathSchema,
  z.object({
    source: piResourcePathSchema,
    autoload: z.boolean().optional(),
    extensions: piResourcePathsSchema.optional(),
    skills: piResourcePathsSchema.optional(),
    prompts: piResourcePathsSchema.optional(),
    themes: piResourcePathsSchema.optional()
  })
]);

export const piSettingsSchema = z.object({
  autoCompact: z.boolean(),
  autoResizeImages: z.boolean(),
  blockImages: z.boolean(),
  enableSkillCommands: z.boolean(),
  steeringMode: z.enum(["one-at-a-time", "all"]),
  followUpMode: z.enum(["one-at-a-time", "all"]),
  transport: z.enum(["sse", "websocket", "websocket-cached", "auto"]),
  httpIdleTimeoutMs: z.number().int().nonnegative(),
  hideThinkingBlock: z.boolean(),
  mermaidRenderingMode: z.enum(["off", "final", "streaming"]),
  showCacheMissNotices: z.boolean(),
  collapseChangelog: z.boolean(),
  quietStartup: z.boolean(),
  enableInstallTelemetry: z.boolean(),
  defaultProjectTrust: z.enum(["ask", "always", "never"]),
  doubleEscapeAction: z.enum(["fork", "tree", "none"]),
  treeFilterMode: z.enum(["default", "no-tools", "user-only", "labeled-only", "all"]),
  anthropicExtraUsageWarning: z.boolean(),
  retryEnabled: z.boolean(),
  shellPath: z.string().max(4_096),
  shellCommandPrefix: z.string().max(16_384),
  npmCommand: z.array(z.string().max(4_096)).max(100),
  packages: z.array(piPackageSourceSchema).max(1_000),
  extensions: piResourcePathsSchema,
  skills: piResourcePathsSchema,
  prompts: piResourcePathsSchema,
  reloadPending: z.boolean()
});

export const piSettingUpdateSchema = z.discriminatedUnion("key", [
  z.object({ key: z.literal("autoCompact"), value: z.boolean() }),
  z.object({ key: z.literal("autoResizeImages"), value: z.boolean() }),
  z.object({ key: z.literal("blockImages"), value: z.boolean() }),
  z.object({ key: z.literal("enableSkillCommands"), value: z.boolean() }),
  z.object({ key: z.literal("steeringMode"), value: z.enum(["one-at-a-time", "all"]) }),
  z.object({ key: z.literal("followUpMode"), value: z.enum(["one-at-a-time", "all"]) }),
  z.object({ key: z.literal("transport"), value: z.enum(["sse", "websocket", "websocket-cached", "auto"]) }),
  z.object({ key: z.literal("httpIdleTimeoutMs"), value: z.number().int().nonnegative() }),
  z.object({ key: z.literal("hideThinkingBlock"), value: z.boolean() }),
  z.object({ key: z.literal("mermaidRenderingMode"), value: z.enum(["off", "final", "streaming"]) }),
  z.object({ key: z.literal("showCacheMissNotices"), value: z.boolean() }),
  z.object({ key: z.literal("collapseChangelog"), value: z.boolean() }),
  z.object({ key: z.literal("quietStartup"), value: z.boolean() }),
  z.object({ key: z.literal("enableInstallTelemetry"), value: z.boolean() }),
  z.object({ key: z.literal("defaultProjectTrust"), value: z.enum(["ask", "always", "never"]) }),
  z.object({ key: z.literal("doubleEscapeAction"), value: z.enum(["fork", "tree", "none"]) }),
  z.object({ key: z.literal("treeFilterMode"), value: z.enum(["default", "no-tools", "user-only", "labeled-only", "all"]) }),
  z.object({ key: z.literal("anthropicExtraUsageWarning"), value: z.boolean() }),
  z.object({ key: z.literal("retryEnabled"), value: z.boolean() }),
  z.object({ key: z.literal("shellPath"), value: z.string().max(4_096) }),
  z.object({ key: z.literal("shellCommandPrefix"), value: z.string().max(16_384) }),
  z.object({ key: z.literal("npmCommand"), value: z.array(z.string().max(4_096)).max(100) }),
  z.object({ key: z.literal("packages"), value: z.array(piPackageSourceSchema).max(1_000) }),
  z.object({ key: z.literal("extensions"), value: piResourcePathsSchema }),
  z.object({ key: z.literal("skills"), value: piResourcePathsSchema }),
  z.object({ key: z.literal("prompts"), value: piResourcePathsSchema })
]);

export const fileSuggestionSchema = z.object({
  value: z.string().min(1).max(4_096),
  label: ipcProjectionString(512).pipe(z.string().min(1)),
  description: ipcProjectionString(4_096).optional()
});

export const attachmentSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("file"),
    name: z.string().max(512),
    path: z.string().max(4_096)
  }),
  z.object({
    kind: z.literal("image"),
    name: z.string().max(512),
    mimeType: z.string().max(128),
    data: z.string().max(20_000_000)
  })
]);

const partBase = { id: z.string().min(1).max(256) };

export const uiPartSchema = z.discriminatedUnion("kind", [
  z.object({
    ...partBase,
    kind: z.literal("text"),
    role: z.enum(["user", "assistant"]),
    entryId: z.string().min(1).max(256).optional(),
    text: boundedText,
    status: z.enum(["streaming", "complete", "error"])
  }),
  z.object({
    ...partBase,
    kind: z.literal("reasoning"),
    text: boundedText,
    status: z.enum(["streaming", "complete"])
  }),
  z.object({
    ...partBase,
    kind: z.literal("tool"),
    name: ipcProjectionString(256),
    input: boundedText,
    output: boundedText.optional(),
    artifactId: z.string().min(1).max(256).optional(),
    filePath: z.string().max(8_192).optional(),
    diff: boundedText.optional(),
    state: z.enum(["approval", "running", "success", "error", "denied"])
  }),
  z.object({
    ...partBase,
    kind: z.literal("source"),
    title: ipcProjectionString(1_024),
    url: z.string().max(8_192)
  }),
  z.object({
    ...partBase,
    kind: z.literal("attachment"),
    name: ipcProjectionString(512),
    mediaType: z.string().max(128),
    attachmentKind: z.enum(["file", "image"]),
    data: z.string().max(20_000_000).optional()
  }),
  z.object({
    ...partBase,
    kind: z.literal("notice"),
    tone: z.enum(["info", "warning", "error"]),
    title: ipcProjectionString(512),
    detail: boundedText.optional()
  }),
  z.object({
    ...partBase,
    kind: z.literal("review-run"),
    operationId: z.uuid(),
    threadIds: z.array(z.string().min(1).max(256)).min(1).max(100),
    commentCount: z.number().int().positive().max(1_000_000),
    status: z.enum(["running", "complete", "error"])
  })
]);

export const modelOptionSchema = z.object({
  provider: z.string().max(256),
  providerName: ipcProjectionString(512),
  id: z.string().max(512),
  name: ipcProjectionString(1_024),
  reasoning: z.boolean(),
  input: ipcProjectionArray(z.enum(["text", "image"]), 2),
  authenticated: z.boolean(),
  authSource: z.enum(["stored", "runtime", "environment", "fallback", "models_json_key", "models_json_command"]).optional(),
  authLabel: ipcProjectionString(512).optional(),
  authTypes: ipcProjectionArray(z.enum(["api_key", "oauth"]), 2)
});

export const sessionUsageSchema = z.object({
  tokens: z.object({
    input: z.number().int().nonnegative(),
    output: z.number().int().nonnegative(),
    cacheRead: z.number().int().nonnegative(),
    cacheWrite: z.number().int().nonnegative(),
    total: z.number().int().nonnegative()
  }),
  cost: z.number().nonnegative(),
  context: z.object({
    tokens: z.number().int().nonnegative().nullable(),
    contextWindow: z.number().int().positive(),
    percent: z.number().nonnegative().nullable()
  }).optional()
});

export const sessionSummarySchema = z.object({
  id: z.string().min(1).max(256),
  title: ipcProjectionString(SESSION_TITLE_MAX_LENGTH),
  created: z.string().datetime(),
  modified: z.string().datetime(),
  messageCount: z.number().int().nonnegative(),
  parentSessionId: z.string().max(256).optional(),
  archived: z.boolean().default(false)
});

export const globalSessionSummarySchema = sessionSummarySchema.extend({
  workspacePath: z.string().min(1).max(4_096),
  workspaceName: ipcProjectionString(512).pipe(z.string().min(1))
});

export const sessionTreeEntrySchema = z.object({
  id: z.string().min(1).max(256),
  parentId: z.string().max(256).optional(),
  type: z.string().max(128),
  messageRole: z.string().max(128).optional(),
  editorText: boundedText.optional(),
  label: ipcProjectionString(512).optional(),
  preview: ipcProjectionString(2_048),
  active: z.boolean()
});

export const changedFileSchema = z.object({
  path: z.string().max(4_096),
  previousPath: z.string().max(4_096).optional(),
  status: z.enum(["added", "modified", "deleted", "renamed", "copied"]),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  diff: boundedText
});

export const resourceScopeSchema = z.enum(["user", "project", "temporary"]);

export const compatibilityResourceSchema = z.object({
  id: z.string().min(1).max(8_192),
  kind: z.enum(["skill", "prompt", "package", "extension"]),
  name: ipcProjectionString(1_024).pipe(z.string().min(1)),
  description: ipcProjectionString(4_096).optional(),
  path: z.string().max(8_192).optional(),
  source: ipcProjectionString(2_048),
  scope: resourceScopeSchema,
  origin: z.enum(["package", "top-level"]),
  commands: ipcProjectionArray(z.string().max(256), 1_000).default([]),
  tools: ipcProjectionArray(z.string().max(256), 1_000).default([]),
  enabled: z.boolean().default(true)
});

export const resourceDiagnosticSchema = z.object({
  id: z.string().min(1).max(8_192),
  severity: z.enum(["info", "warning", "error"]),
  source: z.enum(["extension", "skill", "prompt", "package", "compatibility", "runtime"]),
  message: ipcProjectionString(4_096),
  path: z.string().max(8_192).optional(),
  method: ipcProjectionString(256).optional()
});

export const compatibilityCatalogSchema = z.object({
  resources: ipcProjectionArray(compatibilityResourceSchema, 20_000).default([]),
  diagnostics: ipcProjectionArray(resourceDiagnosticSchema, 5_000).default([])
});

export const extensionUiStateSchema = z.object({
  title: ipcProjectionString(512).optional(),
  statuses: ipcProjectionArray(z.object({ key: z.string().max(256), text: ipcProjectionString(2_048) }), 100).default([])
});

export const slashCommandSchema = z.object({
  name: z.string().min(1).max(256),
  description: ipcProjectionString(4_096).optional(),
  argumentHint: ipcProjectionString(512).optional(),
  source: z.enum(["builtin", "extension", "prompt", "skill", "plugin"]),
  sourceInfo: z.object({
    path: z.string().max(8_192),
    source: ipcProjectionString(2_048),
    scope: resourceScopeSchema,
    origin: z.enum(["package", "top-level"])
  })
});

const builtinSourceInfo = { path: "builtin:pi-cli", source: "Pi CLI", scope: "temporary", origin: "top-level" } as const;

// Mirrors BUILTIN_SLASH_COMMANDS from @earendil-works/pi-coding-agent 0.84.0.
// Pi's getCommands() intentionally returns only extension, prompt, and skill commands.
export const piBuiltinSlashCommands = [
  { name: "settings", description: "Open settings menu" },
  { name: "model", description: "Select model (opens selector UI)", argumentHint: "<provider/model>" },
  { name: "scoped-models", description: "Enable/disable models for Ctrl+P cycling" },
  { name: "export", description: "Export session (HTML default, or specify path: .html/.jsonl)" },
  { name: "import", description: "Import and resume a session from a JSONL file" },
  { name: "share", description: "Share session as a secret GitHub gist" },
  { name: "copy", description: "Copy last agent message to clipboard" },
  { name: "name", description: "Set session display name" },
  { name: "session", description: "Show session info and stats" },
  { name: "changelog", description: "Show changelog entries" },
  { name: "hotkeys", description: "Show all keyboard shortcuts" },
  { name: "fork", description: "Create a new fork from a previous user message" },
  { name: "clone", description: "Duplicate the current session at the current position" },
  { name: "tree", description: "Navigate session tree (switch branches)" },
  { name: "trust", description: "Save project trust decision for future sessions" },
  { name: "login", description: "Configure provider authentication", argumentHint: "<provider>" },
  { name: "logout", description: "Remove provider authentication" },
  { name: "new", description: "Start a new session" },
  { name: "compact", description: "Manually compact the session context" },
  { name: "resume", description: "Resume a different session" },
  { name: "reload", description: "Reload keybindings, extensions, skills, prompts, themes, and context files" },
  { name: "quit", description: "Quit pi" }
].map((command) => slashCommandSchema.parse({ ...command, source: "builtin", sourceInfo: builtinSourceInfo }));

export const extensionUiEventSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("notify"), id: ipcProjectionString(256), message: ipcProjectionString(4_096), tone: z.enum(["info", "warning", "error"]) }),
  z.object({ kind: z.literal("status"), key: z.string().max(256), text: ipcProjectionString(2_048).optional() }),
  z.object({ kind: z.literal("title"), title: ipcProjectionString(512) }),
  z.object({ kind: z.literal("editor-text"), text: boundedText, mode: z.enum(["replace", "insert"]) }),
  z.object({ kind: z.literal("diagnostic"), diagnostic: resourceDiagnosticSchema })
]);

export const sessionSnapshotSchema = z.object({
  workspacePath: z.string().max(4_096),
  sessionId: z.string().min(1).max(256),
  sessionFile: z.string().max(4_096),
  parts: ipcProjectionArray(uiPartSchema, 50_000),
  model: z.object({ provider: z.string(), id: z.string(), name: z.string() }).optional(),
  models: ipcProjectionArray(modelOptionSchema, 5_000),
  thinkingLevel: thinkingLevelSchema,
  availableThinkingLevels: ipcProjectionArray(thinkingLevelSchema, 7),
  piSettings: piSettingsSchema.optional(),
  streaming: z.boolean(),
  diagnostics: ipcProjectionArray(ipcProjectionString(4_096), 1_000),
  commands: ipcProjectionArray(slashCommandSchema, 20_000),
  usage: sessionUsageSchema.optional(),
  compatibility: compatibilityCatalogSchema.default({ resources: [], diagnostics: [] }),
  extensionUi: extensionUiStateSchema.default({ statuses: [] }),
  sessions: ipcProjectionArray(sessionSummarySchema, 10_000).default([]),
  tree: ipcProjectionArray(sessionTreeEntrySchema, 50_000).default([]),
  artifacts: ipcProjectionArray(artifactRecordSchema, 10_000).optional()
});

export const sessionPreviewSchema = z.object({
  workspacePath: z.string().max(4_096),
  sessionId: z.string().min(1).max(256),
  sessionFile: z.string().max(4_096),
  parts: ipcProjectionArray(uiPartSchema, 50_000)
});

export const projectRecordSchema = z.object({
  path: z.string().min(1).max(4_096),
  name: z.string().min(1).max(512),
  addedAt: z.string().datetime(),
  lastOpenedAt: z.string().datetime(),
  archivedSessionIds: z.array(z.string().max(256)).max(10_000).default([])
});

export const applicationStateSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  projects: z.array(projectRecordSchema).max(200).default([]),
  trustedProjectPaths: z.array(z.string().max(4_096)).max(200).default([])
});

export const windowConversationSelectionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("project-session"), workspacePath: z.string().min(1).max(4_096), sessionId: z.string().min(1).max(256) }),
  z.object({ kind: z.literal("cake-chat"), sessionId: z.string().min(1).max(256) })
]);

export const windowViewStateSchema = z.object({
  projectPath: z.string().max(4_096).optional(),
  selectedSessionId: z.string().max(256).optional(),
  activeConversation: windowConversationSelectionSchema.optional(),
  recentProjectPaths: z.array(z.string().max(4_096)).max(50).default([]),
  draft: z.string().max(262_144).default(""),
  theme: z.enum(["system", "light", "dark"]).default("system"),
  thinkingExpanded: z.boolean().default(false),
  draftsBySession: z.record(z.string(), z.string().max(262_144)).default({})
});

export type FileSuggestion = z.infer<typeof fileSuggestionSchema>;
export type Attachment = z.infer<typeof attachmentSchema>;
export type UiPart = z.infer<typeof uiPartSchema>;
export type ModelOption = z.infer<typeof modelOptionSchema>;
export type ThinkingLevel = z.infer<typeof thinkingLevelSchema>;
export type PiSettings = z.infer<typeof piSettingsSchema>;
export type PiSettingUpdate = z.infer<typeof piSettingUpdateSchema>;
export type SessionSnapshot = z.infer<typeof sessionSnapshotSchema>;
export type SessionPreview = z.infer<typeof sessionPreviewSchema>;
export type SessionSummary = z.infer<typeof sessionSummarySchema>;
export type GlobalSessionSummary = z.infer<typeof globalSessionSummarySchema>;
export type SessionTreeEntry = z.infer<typeof sessionTreeEntrySchema>;
export type ChangedFile = z.infer<typeof changedFileSchema>;
export type CompatibilityResource = z.infer<typeof compatibilityResourceSchema>;
export type ResourceDiagnostic = z.infer<typeof resourceDiagnosticSchema>;
export type CompatibilityCatalog = z.infer<typeof compatibilityCatalogSchema>;
export type ExtensionUiState = z.infer<typeof extensionUiStateSchema>;
export type ExtensionUiEvent = z.infer<typeof extensionUiEventSchema>;
export type ProjectRecord = z.infer<typeof projectRecordSchema>;
export type ApplicationState = z.infer<typeof applicationStateSchema>;
export type WindowConversationSelection = z.infer<typeof windowConversationSelectionSchema>;
export type WindowViewState = z.infer<typeof windowViewStateSchema>;
