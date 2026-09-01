import { Effect, Schema } from "effect";

const defaultKey = <S extends Schema.Top>(schema: S, value: S["Type"]) =>
  schema.pipe(Schema.withDecodingDefaultKey(Effect.succeed(value)));
const digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
export const pluginIdSchema = Schema.String.check(
  Schema.isPattern(/^[a-z0-9]+(?:[.-][a-z0-9]+)+$/),
  Schema.isMaxLength(128),
);
export const cakePluginManifestSchema = Schema.Struct({
  schemaVersion: Schema.Literal(2),
  id: pluginIdSchema,
  name: Schema.Trim.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(128))),
  renderer: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1_024))),
  backend: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1_024))),
  scene: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1_024))),
  activeScene: defaultKey(Schema.Boolean, false),
  enabled: defaultKey(Schema.Boolean, true),
}).check(
  Schema.makeFilter((manifest) =>
    manifest.renderer || manifest.backend || manifest.scene
      ? undefined
      : "A plugin must declare a renderer, a backend, a scene, or a combination of them",
  ),
  Schema.makeFilter((manifest) =>
    !manifest.activeScene || manifest.scene
      ? undefined
      : "Only a plugin with a scene entry may set activeScene",
  ),
  Schema.makeFilter((manifest) =>
    !manifest.scene || manifest.scene !== manifest.renderer
      ? undefined
      : "Renderer and scene entries must be separate modules",
  ),
);
export type CakePluginManifest = typeof cakePluginManifestSchema.Type;
export const pluginDiagnosticSchema = Schema.Struct({
  phase: Schema.Literals([
    "discovery",
    "typecheck",
    "bundle",
    "backend",
    "import",
    "render",
    "runtime",
  ]),
  pluginId: Schema.optionalKey(pluginIdSchema),
  file: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(4_096))),
  message: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(32_768)),
});
export type PluginDiagnostic = typeof pluginDiagnosticSchema.Type;
export const customizationStateSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  sourceRevision: Schema.optional(digest),
  activeRevision: Schema.optional(digest),
  lastKnownGoodRevision: Schema.optional(digest),
  rollbackRevision: Schema.optional(digest),
  validatedRevision: Schema.optional(digest),
  pendingRevision: Schema.optional(digest),
  failedRevision: Schema.optional(digest),
  recoveryRequired: defaultKey(Schema.Boolean, false),
  diagnostics: defaultKey(
    Schema.Array(pluginDiagnosticSchema).check(Schema.isMaxLength(1_000)),
    [],
  ),
  updatedAt: Schema.String,
});
export type CustomizationState = typeof customizationStateSchema.Type;
export const customizationProvenanceSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  attemptId: Schema.String.check(Schema.isUUID()),
  request: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(8_192)),
  baseRevision: Schema.optional(digest),
  resultingRevision: digest,
  result: Schema.Literals([
    "rejected",
    "validated",
    "candidate",
    "activated",
    "failed",
    "rolled-back",
    "factory",
  ]),
  diagnostics: defaultKey(
    Schema.Array(pluginDiagnosticSchema).check(Schema.isMaxLength(1_000)),
    [],
  ),
  recordedAt: Schema.String,
});
export const pluginPersistenceKeySchema = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  Schema.isMaxLength(128),
);
export const pluginPersistenceScopeSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("global") }),
  Schema.Struct({
    kind: Schema.Literal("session"),
    sessionId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  }),
]);
export const pluginPersistenceRecordSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  pluginId: pluginIdSchema,
  key: pluginPersistenceKeySchema,
  scope: pluginPersistenceScopeSchema,
  value: Schema.Json,
  version: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  sourceRevision: Schema.optional(digest),
  updatedAt: Schema.String,
});
export type PluginPersistenceScope = typeof pluginPersistenceScopeSchema.Type;
export type PluginPersistenceRecord = typeof pluginPersistenceRecordSchema.Type;
export type PluginPersistenceValue = PluginPersistenceRecord["value"];
export const pluginStatusSchema = Schema.Struct({
  id: pluginIdSchema,
  name: Schema.Trim.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(128))),
  enabled: Schema.Boolean,
  renderer: Schema.optional(Schema.String.check(Schema.isMaxLength(1_024))),
  backend: Schema.optional(Schema.String.check(Schema.isMaxLength(1_024))),
  scene: Schema.optional(Schema.String.check(Schema.isMaxLength(1_024))),
  activeScene: Schema.Boolean,
  diagnostics: Schema.Array(pluginDiagnosticSchema).check(Schema.isMaxLength(100)),
});
export type PluginStatus = typeof pluginStatusSchema.Type;
export const pluginBackendEventSchema = Schema.Struct({
  pluginId: pluginIdSchema,
  name: Schema.String.check(
    Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
    Schema.isMaxLength(256),
  ),
  value: Schema.Json,
});
