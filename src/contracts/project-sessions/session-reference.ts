import { Schema } from "effect";
import { jsonObjectSchema, type JsonValue } from "../serialization/json-contract";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const shortReference = /^s:([0-9a-f]{8,32})$/i;
const hex = (id: string) => id.replaceAll("-", "").toLowerCase();

/** Agent-facing identity only. UUIDv7 prefixes are not sufficiently distinctive. */
export function sessionReference(sessionId: string, knownSessionIds: readonly string[]): string {
  if (!uuid.test(sessionId)) return sessionId;
  const value = hex(sessionId);
  const others = knownSessionIds.filter((id) => uuid.test(id) && hex(id) !== value).map(hex);
  let length = 8;
  while (length < 32 && others.some((other) => other.endsWith(value.slice(-length)))) length++;
  return `s:${value.slice(-length)}`;
}

export type SessionReferenceResolution =
  | { readonly ok: true; readonly sessionId: string }
  | { readonly ok: false; readonly error: string };

/** Exact catalog identities pass through unchanged; references never select the first match. */
export function resolveSessionReference(
  reference: string,
  knownSessionIds: readonly string[],
): SessionReferenceResolution {
  if (knownSessionIds.includes(reference)) return { ok: true, sessionId: reference };
  const suffix = shortReference.exec(reference)?.[1]?.toLowerCase();
  if (!suffix) return { ok: false, error: `Unknown session reference: ${reference}` };
  const matches = [...new Set(knownSessionIds)].filter(
    (id) => uuid.test(id) && hex(id).endsWith(suffix),
  );
  const [match] = matches;
  if (matches.length === 1 && match !== undefined) return { ok: true, sessionId: match };
  return {
    ok: false,
    error:
      matches.length === 0
        ? `Unknown session reference: ${reference}`
        : `Ambiguous session reference: ${reference}; use a longer suffix or the full UUID`,
  };
}

const identityKey = (key: string) =>
  /SessionIds?$/.test(key) || key === "sessionId" || key === "sessionIds";
const audienceKey = (key: string) => key === "audience";

/** Project only identity fields, never user text, paths, family IDs, or message/thread IDs. */
export function projectSessionReferences(
  value: JsonValue,
  knownSessionIds: readonly string[],
): JsonValue {
  const visit = (item: JsonValue, key = ""): JsonValue => {
    if (Schema.is(Schema.String)(item))
      return identityKey(key) || audienceKey(key) ? sessionReference(item, knownSessionIds) : item;
    if (Array.isArray(item)) return item.map((child) => visit(child, key));
    if (!Schema.is(jsonObjectSchema)(item)) return item;
    return Object.fromEntries(
      Object.entries(item).map(([name, child]) => [name, visit(child, name)]),
    );
  };
  return visit(value);
}
