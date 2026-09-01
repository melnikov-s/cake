import { Schema } from "effect";

/** JSON data that can safely cross Cake's process and plugin boundaries. */
export const jsonValueSchema = Schema.Json;
export type JsonValue = typeof jsonValueSchema.Type;

export const jsonObjectSchema = Schema.Record(Schema.String, jsonValueSchema);
export type JsonObject = typeof jsonObjectSchema.Type;
