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
  label?: string;
  preview: string;
  active: boolean;
  children: Array<z.infer<typeof sessionTreeNodeSchema>>;
}> = z.lazy(() => z.object({
  id: z.string().min(1).max(256),
  parentId: z.string().max(256).optional(),
  type: z.string().max(128),
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
