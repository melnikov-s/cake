import { Schema } from "effect";
import type { JsonValue } from "../ipc/json-contract";

/** Normalize a trusted process-local projection before it crosses a JSON boundary. */
export const toJsonValue = <A>(value: A): JsonValue => {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError("Expected a serializable JSON value");
  return Schema.decodeUnknownSync(Schema.Json)(JSON.parse(serialized));
};
