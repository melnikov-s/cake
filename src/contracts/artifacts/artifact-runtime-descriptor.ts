import { Schema } from "effect";

const JsonSchemaDocument = Schema.Union([
  Schema.Boolean,
  Schema.Record(Schema.String, Schema.Json),
]);
export const ArtifactRuntimeTool = Schema.Struct({
  name: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(128),
    Schema.isPattern(/^[A-Za-z][A-Za-z0-9._-]*$/),
  ),
  description: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
  inputSchema: JsonSchemaDocument,
  outputSchema: JsonSchemaDocument,
});
export interface ArtifactRuntimeTool extends Schema.Schema.Type<typeof ArtifactRuntimeTool> {}

/** Async factory body returning { tools, lifecycle? }; runs in a backend QuickJS worker. */
export const ArtifactRuntimeDescriptor = Schema.Struct({
  source: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1_048_576)),
  tools: Schema.Array(ArtifactRuntimeTool).check(
    Schema.isMaxLength(128),
    Schema.makeFilter((tools) =>
      new Set(tools.map((tool) => tool.name)).size === tools.length
        ? undefined
        : "Artifact runtime tool names must be unique",
    ),
  ),
});
export interface ArtifactRuntimeDescriptor extends Schema.Schema.Type<
  typeof ArtifactRuntimeDescriptor
> {}
