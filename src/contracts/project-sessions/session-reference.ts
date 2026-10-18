import { Schema } from "effect";
import { jsonObjectSchema, type JsonValue } from "../serialization/json-contract";
import { CAKE_CHAT_REFERENCE, CAKE_CHAT_SESSION_ID } from "../cake-chats/cake-chat-identity";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const shortReference = /^([0-9a-f]{8,64})$/i;
const hex = (id: string) => id.replaceAll("-", "").toLowerCase();
const referenceHex = (id: string) =>
  uuid.test(id) ? hex(id) : /^project-chat:([0-9a-f]{64})$/i.exec(id)?.[1]?.toLowerCase();

/** Agent-facing identity only. UUIDv7 prefixes are not sufficiently distinctive. */
export function sessionReference(sessionId: string, knownSessionIds: readonly string[]): string {
  if (sessionId === CAKE_CHAT_SESSION_ID) return CAKE_CHAT_REFERENCE;
  const value = referenceHex(sessionId);
  if (!value) return sessionId;
  const others = knownSessionIds
    .filter((id) => id !== CAKE_CHAT_SESSION_ID && id !== sessionId)
    .flatMap((id) => {
      const other = referenceHex(id);
      return other && other !== value ? [other] : [];
    });
  let length = 8;
  while (length < value.length && others.some((other) => other.endsWith(value.slice(-length))))
    length++;
  return others.some((other) => other.endsWith(value.slice(-length)))
    ? sessionId
    : value.slice(-length);
}

export type SessionReferenceResolution =
  | { readonly ok: true; readonly sessionId: string }
  | { readonly ok: false; readonly error: string };

/** Full UUIDs can be authoritatively looked up even if discovery is stale.
 * Short references never select the first match or search outside the discovered roster. */
export function resolveSessionReference(
  reference: string,
  knownSessionIds: readonly string[],
): SessionReferenceResolution {
  // The emitted Cake Chat label routes to Cake Chat; callers decide whether it is a valid target.
  if (reference === CAKE_CHAT_REFERENCE) return { ok: true, sessionId: CAKE_CHAT_SESSION_ID };
  if (knownSessionIds.includes(reference) || uuid.test(reference))
    return { ok: true, sessionId: reference };
  const suffix = shortReference.exec(reference)?.[1]?.toLowerCase();
  if (!suffix) return { ok: false, error: `Unknown session reference: ${reference}` };
  const matches = [...new Set(knownSessionIds)].filter(
    (id) => id !== CAKE_CHAT_SESSION_ID && referenceHex(id)?.endsWith(suffix),
  );
  const [match] = matches;
  if (matches.length === 1 && match !== undefined) return { ok: true, sessionId: match };
  return {
    ok: false,
    error:
      matches.length === 0
        ? `Unknown session reference: ${reference}`
        : `Ambiguous session reference: ${reference}; use a longer suffix or the canonical session ID`,
  };
}

/** Deep links accept emitted bare suffixes.
 * Any other target is passed through unchanged for the caller's authoritative lookup. */
export function resolveSessionLinkReference(
  reference: string,
  knownSessionIds: readonly string[],
): SessionReferenceResolution {
  if (knownSessionIds.includes(reference)) return { ok: true, sessionId: reference };
  if (shortReference.test(reference)) return resolveSessionReference(reference, knownSessionIds);
  return { ok: true, sessionId: reference };
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
