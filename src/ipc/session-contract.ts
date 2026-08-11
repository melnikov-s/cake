import { z } from "zod";
import { artifactRecordSchema } from "./artifact-contract";

const boundedText = z.string().max(262_144);

export const thinkingLevelSchema = z.enum([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max"
]);

export const fileSuggestionSchema = z.object({
  value: z.string().min(1).max(4_096),
  label: z.string().min(1).max(512),
  description: z.string().max(4_096).optional()
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
    name: z.string().max(256),
    input: boundedText,
    output: boundedText.optional(),
    state: z.enum(["approval", "running", "success", "error", "denied"])
  }),
  z.object({
    ...partBase,
    kind: z.literal("source"),
    title: z.string().max(1_024),
    url: z.string().max(8_192)
  }),
  z.object({
    ...partBase,
    kind: z.literal("attachment"),
    name: z.string().max(512),
    mediaType: z.string().max(128),
    attachmentKind: z.enum(["file", "image"])
  }),
  z.object({
    ...partBase,
    kind: z.literal("notice"),
    tone: z.enum(["info", "warning", "error"]),
    title: z.string().max(512),
    detail: boundedText.optional()
  })
]);

export const modelOptionSchema = z.object({
  provider: z.string().max(256),
  providerName: z.string().max(512),
  id: z.string().max(512),
  name: z.string().max(1_024),
  reasoning: z.boolean(),
  input: z.array(z.enum(["text", "image"])).max(2),
  authenticated: z.boolean(),
  authTypes: z.array(z.enum(["api_key", "oauth"])).max(2)
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
  title: z.string().max(1_024),
  created: z.string().datetime(),
  modified: z.string().datetime(),
  messageCount: z.number().int().nonnegative(),
  parentSessionId: z.string().max(256).optional(),
  archived: z.boolean().default(false)
});

export const globalSessionSummarySchema = sessionSummarySchema.extend({
  workspacePath: z.string().min(1).max(4_096),
  workspaceName: z.string().min(1).max(512)
});

export const sessionTreeNodeSchema: z.ZodType<{
  id: string;
  parentId?: string;
  type: string;
  messageRole?: string;
  editorText?: string;
  label?: string;
  preview: string;
  active: boolean;
  children: Array<z.infer<typeof sessionTreeNodeSchema>>;
}> = z.lazy(() => z.object({
  id: z.string().min(1).max(256),
  parentId: z.string().max(256).optional(),
  type: z.string().max(128),
  messageRole: z.string().max(128).optional(),
  editorText: boundedText.optional(),
  label: z.string().max(512).optional(),
  preview: z.string().max(2_048),
  active: z.boolean(),
  children: z.array(sessionTreeNodeSchema).max(50_000)
}));

export const changedFileSchema = z.object({
  path: z.string().max(4_096),
  status: z.string().min(1).max(8),
  staged: z.boolean(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  diff: boundedText
});

export const resourceScopeSchema = z.enum(["user", "project", "temporary"]);

export const compatibilityResourceSchema = z.object({
  id: z.string().min(1).max(8_192),
  kind: z.enum(["skill", "prompt", "package", "extension"]),
  name: z.string().min(1).max(1_024),
  description: z.string().max(4_096).optional(),
  path: z.string().max(8_192).optional(),
  source: z.string().max(2_048),
  scope: resourceScopeSchema,
  origin: z.enum(["package", "top-level"]),
  commands: z.array(z.string().max(256)).max(1_000).default([]),
  tools: z.array(z.string().max(256)).max(1_000).default([]),
  enabled: z.boolean().default(true)
});

export const resourceDiagnosticSchema = z.object({
  id: z.string().min(1).max(8_192),
  severity: z.enum(["info", "warning", "error"]),
  source: z.enum(["extension", "skill", "prompt", "package", "compatibility", "runtime"]),
  message: z.string().max(4_096),
  path: z.string().max(8_192).optional(),
  method: z.string().max(256).optional()
});

export const compatibilityCatalogSchema = z.object({
  resources: z.array(compatibilityResourceSchema).max(20_000).default([]),
  diagnostics: z.array(resourceDiagnosticSchema).max(5_000).default([])
});

export const extensionUiStateSchema = z.object({
  title: z.string().max(512).optional(),
  statuses: z.array(z.object({ key: z.string().max(256), text: z.string().max(2_048) })).max(100).default([]),
  widgets: z.array(z.object({
    key: z.string().max(256),
    lines: z.array(z.string().max(4_096)).max(1_000),
    placement: z.enum(["aboveEditor", "belowEditor"])
  })).max(100).default([])
});

export const slashCommandSchema = z.object({
  name: z.string().min(1).max(256),
  description: z.string().max(4_096).optional(),
  argumentHint: z.string().max(512).optional(),
  source: z.enum(["builtin", "extension", "prompt", "skill"]),
  sourceInfo: z.object({
    path: z.string().max(8_192),
    source: z.string().max(2_048),
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
  z.object({ kind: z.literal("notify"), id: z.string().max(256), message: z.string().max(4_096), tone: z.enum(["info", "warning", "error"]) }),
  z.object({ kind: z.literal("status"), key: z.string().max(256), text: z.string().max(2_048).optional() }),
  z.object({ kind: z.literal("title"), title: z.string().max(512) }),
  z.object({ kind: z.literal("editor-text"), text: boundedText, mode: z.enum(["replace", "insert"]) }),
  z.object({ kind: z.literal("widget"), key: z.string().max(256), lines: z.array(z.string().max(4_096)).max(1_000).optional(), placement: z.enum(["aboveEditor", "belowEditor"]) }),
  z.object({ kind: z.literal("diagnostic"), diagnostic: resourceDiagnosticSchema })
]);

export const sessionSnapshotSchema = z.object({
  workspacePath: z.string().max(4_096),
  sessionId: z.string().min(1).max(256),
  sessionFile: z.string().max(4_096),
  parts: z.array(uiPartSchema).max(50_000),
  model: z.object({ provider: z.string(), id: z.string(), name: z.string() }).optional(),
  models: z.array(modelOptionSchema).max(5_000),
  thinkingLevel: thinkingLevelSchema,
  availableThinkingLevels: z.array(thinkingLevelSchema).max(7),
  streaming: z.boolean(),
  diagnostics: z.array(z.string().max(4_096)).max(1_000),
  commands: z.array(slashCommandSchema).max(20_000),
  usage: sessionUsageSchema.optional(),
  compatibility: compatibilityCatalogSchema.default({ resources: [], diagnostics: [] }),
  extensionUi: extensionUiStateSchema.default({ statuses: [], widgets: [] }),
  sessions: z.array(sessionSummarySchema).max(10_000).default([]),
  tree: z.array(sessionTreeNodeSchema).max(50_000).default([])
  ,artifacts: z.array(artifactRecordSchema).max(10_000).optional()
});

export const sessionPreviewSchema = z.object({
  workspacePath: z.string().max(4_096),
  sessionId: z.string().min(1).max(256),
  sessionFile: z.string().max(4_096),
  parts: z.array(uiPartSchema).max(50_000)
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
  projects: z.array(projectRecordSchema).max(200).default([])
});

export const windowViewStateSchema = z.object({
  projectPath: z.string().max(4_096).optional(),
  selectedSessionId: z.string().max(256).optional(),
  selectedSessionFile: z.string().max(4_096).optional(),
  recentProjectPaths: z.array(z.string().max(4_096)).max(50).default([]),
  trustedProjectPaths: z.array(z.string().max(4_096)).max(100).default([]),
  draft: z.string().max(262_144).default(""),
  theme: z.enum(["system", "light", "dark"]).default("system"),
  thinkingExpanded: z.boolean().default(false)
  ,sessionSearch: z.string().max(1_024).default("")
  ,draftsBySession: z.record(z.string(), z.string().max(262_144)).default({})
});

export type FileSuggestion = z.infer<typeof fileSuggestionSchema>;
export type Attachment = z.infer<typeof attachmentSchema>;
export type UiPart = z.infer<typeof uiPartSchema>;
export type ModelOption = z.infer<typeof modelOptionSchema>;
export type ThinkingLevel = z.infer<typeof thinkingLevelSchema>;
export type SessionSnapshot = z.infer<typeof sessionSnapshotSchema>;
export type SessionPreview = z.infer<typeof sessionPreviewSchema>;
export type SessionSummary = z.infer<typeof sessionSummarySchema>;
export type GlobalSessionSummary = z.infer<typeof globalSessionSummarySchema>;
export type SessionTreeNode = z.infer<typeof sessionTreeNodeSchema>;
export type ChangedFile = z.infer<typeof changedFileSchema>;
export type CompatibilityResource = z.infer<typeof compatibilityResourceSchema>;
export type ResourceDiagnostic = z.infer<typeof resourceDiagnosticSchema>;
export type CompatibilityCatalog = z.infer<typeof compatibilityCatalogSchema>;
export type ExtensionUiState = z.infer<typeof extensionUiStateSchema>;
export type ExtensionUiEvent = z.infer<typeof extensionUiEventSchema>;
export type ProjectRecord = z.infer<typeof projectRecordSchema>;
export type ApplicationState = z.infer<typeof applicationStateSchema>;
export type WindowViewState = z.infer<typeof windowViewStateSchema>;
