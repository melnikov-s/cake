import { JsonSchema, Schema } from "effect";

/** JSON data that can safely cross Cake's process boundaries. */
export const jsonValueSchema = Schema.Json;
export type JsonValue = typeof jsonValueSchema.Type;

export const jsonObjectSchema = Schema.Record(Schema.String, jsonValueSchema);
export type JsonObject = typeof jsonObjectSchema.Type;

/** Discovery follows Cake's strict boundary decoders, including nested objects. */
export function toDraft07JsonSchema(schema: Schema.Constraint): JsonObject {
  const document = JsonSchema.toDocumentDraft07(
    Schema.toJsonSchemaDocument(schema, { onExcessProperty: "error" }),
  );
  const value: JsonSchema.JsonSchema = {
    $schema: JsonSchema.META_SCHEMA_URI_DRAFT_07,
    ...document.schema,
  };
  if (Object.keys(document.definitions).length > 0) value.definitions = document.definitions;
  return Schema.decodeUnknownSync(jsonObjectSchema)(value);
}
