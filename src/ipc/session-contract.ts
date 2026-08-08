import { z } from "zod";

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
  sessions: z.array(sessionSummarySchema).max(10_000).default([]),
  tree: z.array(sessionTreeNodeSchema).max(50_000).default([])
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
  recentProjectPaths: z.array(z.string().max(4_096)).max(50).default([]),
  trustedProjectPaths: z.array(z.string().max(4_096)).max(100).default([]),
  draft: z.string().max(262_144).default(""),
  theme: z.enum(["system", "light", "dark"]).default("system"),
  thinkingExpanded: z.boolean().default(false)
  ,sessionSearch: z.string().max(1_024).default("")
  ,activeSurface: z.enum(["chat", "changes", "terminal", "tree"]).default("chat")
  ,draftsBySession: z.record(z.string(), z.string().max(262_144)).default({})
});

export type Attachment = z.infer<typeof attachmentSchema>;
export type UiPart = z.infer<typeof uiPartSchema>;
export type ModelOption = z.infer<typeof modelOptionSchema>;
export type ThinkingLevel = z.infer<typeof thinkingLevelSchema>;
export type SessionSnapshot = z.infer<typeof sessionSnapshotSchema>;
export type SessionSummary = z.infer<typeof sessionSummarySchema>;
export type SessionTreeNode = z.infer<typeof sessionTreeNodeSchema>;
export type ChangedFile = z.infer<typeof changedFileSchema>;
export type ProjectRecord = z.infer<typeof projectRecordSchema>;
export type ApplicationState = z.infer<typeof applicationStateSchema>;
export type WindowViewState = z.infer<typeof windowViewStateSchema>;
