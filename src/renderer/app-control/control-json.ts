import { Schema } from "effect";
import { jsonValueSchema, type JsonValue } from "../../ipc/json-contract";
import type { AppControlResult } from "./app-control-data";

export function toStrictJson<T>(value: T): T {
  // SAFETY: callers pass schema-validated JSON-shaped data; the round trip only removes properties whose value is undefined.
  return Schema.decodeUnknownSync(jsonValueSchema)(JSON.parse(JSON.stringify(value))) as T;
}

export function toJsonValue(value: AppControlResult): JsonValue {
  return Schema.decodeUnknownSync(jsonValueSchema)(JSON.parse(JSON.stringify(value)));
}
