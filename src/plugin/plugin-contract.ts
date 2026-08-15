import { z } from "zod";

export const pluginIdSchema = z.string().regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)+$/, "Plugin IDs must be namespaced lowercase identifiers").max(128);

export const cakePluginManifestSchema = z.object({
  schemaVersion: z.literal(1),
  id: pluginIdSchema,
  entry: z.string().min(1).max(1_024).default("index.tsx"),
  enabled: z.boolean().default(true)
});

export type CakePluginManifest = z.infer<typeof cakePluginManifestSchema>;

export const pluginDiagnosticSchema = z.object({
  phase: z.enum(["discovery", "typecheck", "bundle", "import", "render", "runtime"]),
  pluginId: pluginIdSchema.optional(),
  file: z.string().max(4_096).optional(),
  message: z.string().min(1).max(32_768)
});

export type PluginDiagnostic = z.infer<typeof pluginDiagnosticSchema>;

export const customizationStateSchema = z.object({
  schemaVersion: z.literal(1),
  sourceRevision: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  activeRevision: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  lastKnownGoodRevision: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  rollbackRevision: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  pendingRevision: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  failedRevision: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  recoveryRequired: z.boolean().default(false),
  diagnostics: z.array(pluginDiagnosticSchema).max(1_000).default([]),
  updatedAt: z.string().datetime()
});

export type CustomizationState = z.infer<typeof customizationStateSchema>;

export const customizationProvenanceSchema = z.object({
  schemaVersion: z.literal(1),
  attemptId: z.string().uuid(),
  request: z.string().min(1).max(8_192),
  baseRevision: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  resultingRevision: z.string().regex(/^[a-f0-9]{64}$/),
  result: z.enum(["rejected", "candidate", "activated", "failed", "rolled-back", "factory"]),
  diagnostics: z.array(pluginDiagnosticSchema).max(1_000).default([]),
  recordedAt: z.string().datetime()
});
export type CustomizationProvenance = z.infer<typeof customizationProvenanceSchema>;

export const pluginPersistenceKeySchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/).max(128);
export const pluginPersistenceScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("global") }),
  z.object({ kind: z.literal("session"), sessionId: z.string().min(1).max(256) })
]);
export const pluginPersistenceRecordSchema = z.object({
  schemaVersion: z.literal(1), pluginId: pluginIdSchema, key: pluginPersistenceKeySchema,
  scope: pluginPersistenceScopeSchema, value: z.json(), version: z.number().int().nonnegative(),
  sourceRevision: z.string().regex(/^[a-f0-9]{64}$/).optional(), updatedAt: z.string().datetime()
});
export type PluginPersistenceScope = z.infer<typeof pluginPersistenceScopeSchema>;
export type PluginPersistenceRecord = z.infer<typeof pluginPersistenceRecordSchema>;

export const pluginStatusSchema = z.object({ id: pluginIdSchema, enabled: z.boolean(), entry: z.string().max(1_024), diagnostics: z.array(pluginDiagnosticSchema).max(100) });
export type PluginStatus = z.infer<typeof pluginStatusSchema>;
