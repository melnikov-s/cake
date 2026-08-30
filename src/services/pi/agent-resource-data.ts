import { Schema } from "effect";

const boundedString = (maximum: number) => Schema.String.check(Schema.isMaxLength(maximum));
const nonEmptyBoundedString = (maximum: number) =>
  boundedString(maximum).check(Schema.isMinLength(1));

export const PiAgentResourceContext = Schema.Struct({
  workingDirectory: nonEmptyBoundedString(8_192),
  projectTrusted: Schema.Boolean,
  additionalSkillPaths: Schema.optional(
    Schema.Array(nonEmptyBoundedString(8_192)).check(Schema.isMaxLength(256)),
  ),
  additionalPromptTemplatePaths: Schema.optional(
    Schema.Array(nonEmptyBoundedString(8_192)).check(Schema.isMaxLength(256)),
  ),
  additionalExtensionPaths: Schema.optional(
    Schema.Array(nonEmptyBoundedString(8_192)).check(Schema.isMaxLength(256)),
  ),
});

const ResourceSource = Schema.Struct({
  source: boundedString(8_192),
  scope: Schema.Literals(["user", "project", "temporary"]),
  origin: Schema.Literals(["package", "top-level"]),
});

const PiAgentSkill = Schema.Struct({
  kind: Schema.Literal("skill"),
  name: nonEmptyBoundedString(256),
  description: boundedString(8_192),
  path: nonEmptyBoundedString(8_192),
  ...ResourceSource.fields,
});

const PiAgentPromptTemplate = Schema.Struct({
  kind: Schema.Literal("prompt"),
  name: nonEmptyBoundedString(256),
  description: boundedString(8_192),
  argumentHint: Schema.optional(boundedString(2_048)),
  path: nonEmptyBoundedString(8_192),
  ...ResourceSource.fields,
});

const PiAgentExtensionSource = Schema.Struct({
  kind: Schema.Literal("extension"),
  path: nonEmptyBoundedString(8_192),
  resolvedPath: nonEmptyBoundedString(8_192),
  enabled: Schema.Boolean,
  ...ResourceSource.fields,
});

const PiAgentPackageSource = Schema.Struct({
  kind: Schema.Literal("package"),
  source: nonEmptyBoundedString(8_192),
  scope: Schema.Literals(["user", "project"]),
  installedPath: Schema.optional(nonEmptyBoundedString(8_192)),
  enabled: Schema.Boolean,
});

const PiAgentResourceDiagnostic = Schema.Struct({
  id: nonEmptyBoundedString(8_192),
  severity: Schema.Literals(["warning", "error"]),
  source: Schema.Literals(["extension", "skill", "prompt"]),
  message: boundedString(32_000),
  path: Schema.optional(boundedString(8_192)),
});

export const PiAgentResourcesSnapshot = Schema.Struct({
  skills: Schema.Array(PiAgentSkill).check(Schema.isMaxLength(4_096)),
  promptTemplates: Schema.Array(PiAgentPromptTemplate).check(Schema.isMaxLength(4_096)),
  extensionSources: Schema.Array(PiAgentExtensionSource).check(Schema.isMaxLength(4_096)),
  packageSources: Schema.Array(PiAgentPackageSource).check(Schema.isMaxLength(4_096)),
  diagnostics: Schema.Array(PiAgentResourceDiagnostic).check(Schema.isMaxLength(8_192)),
});

export class PiAgentResourcesError extends Schema.TaggedError<PiAgentResourcesError>()(
  "PiAgentResourcesError",
  {
    operation: Schema.Literals(["load", "reload"]),
    message: Schema.String,
  },
) {}

export type PiAgentResourceContext = typeof PiAgentResourceContext.Type;
export type PiAgentResourcesSnapshot = typeof PiAgentResourcesSnapshot.Type;
