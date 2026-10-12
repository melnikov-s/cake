import { Predicate, Schema } from "effect";
import {
  jsonObjectSchema,
  jsonValueSchema,
  type JsonValue,
} from "../../contracts/serialization/json-contract";

export function parseStructuredData(raw: string): JsonValue {
  try {
    return Schema.decodeUnknownSync(jsonValueSchema)(JSON.parse(raw));
  } catch {
    return raw;
  }
}
export function structuredDataFields(
  value: JsonValue,
): ReadonlyArray<readonly [string, JsonValue]> | undefined {
  if (Array.isArray(value)) return value.map((child, index) => [String(index), child] as const);
  if (Schema.is(jsonObjectSchema)(value)) return Object.entries(value);
  return undefined;
}
export function structuredDataImage(value: JsonValue): string | undefined {
  if (
    Predicate.isString(value) &&
    /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=\s]+$/.test(value)
  )
    return value;
  const fields = structuredDataFields(value);
  let mime = fields?.find(([key]) => ["media_type", "mimeType", "mime_type"].includes(key))?.[1];
  let data = fields?.find(([key]) => key === "data")?.[1];
  const format = fields?.find(([key]) => key === "format")?.[1];
  const source = fields?.find(([key]) => key === "source")?.[1];
  if (Predicate.isString(format) && source !== undefined) {
    const bytes = structuredDataFields(source)?.find(([key]) => key === "bytes")?.[1];
    if (bytes !== undefined) {
      const encoded = structuredDataFields(bytes);
      if (encoded?.find(([key]) => key === "encoding")?.[1] === "base64") {
        mime = `image/${format}`;
        data = encoded.find(([key]) => key === "data")?.[1];
      }
    }
  }
  if (
    Predicate.isString(mime) &&
    /^image\/(png|jpeg|webp|gif)$/.test(mime) &&
    Predicate.isString(data) &&
    /^[A-Za-z0-9+/=\s]+$/.test(data)
  )
    return `data:${mime};base64,${data}`;
  return undefined;
}
export function structuredDataText(value: JsonValue): string {
  return Predicate.isString(value) ? value : JSON.stringify(value);
}
