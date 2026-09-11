import type { InlineExtension, SessionManager } from "@earendil-works/pi-coding-agent";
import { Option, Schema } from "effect";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { assertSessionPath } from "./session-path";

/**
 * Prompt cache lineage keeps a forked Pi Session on the same provider cache
 * shard as the session it was forked from.
 *
 * pi-ai derives `prompt_cache_key` (OpenAI Responses, Completions, Codex) and
 * `promptCacheKey` (Mistral) from `Agent.sessionId`. Those keys only choose
 * which machine serves the request; the cache lookup itself is an exact prefix
 * match. A fork's first turn shares its whole prefix with the source, so a
 * per-session key routes it away from the machine that already holds that
 * prefix and guarantees a cold miss. Rewriting only the body parameter to the
 * root ancestor's session ID restores co-location without touching
 * `Agent.sessionId`, which pi-ai also uses for WebSocket pooling and cleanup.
 */

/** Largest prefix of a session file inspected for its header line. */
const HEADER_SCAN_LIMIT = 64 * 1024;
/** Guards the ancestor walk against pathological or cyclic `parentSession` chains. */
const MAX_LINEAGE_DEPTH = 64;
/** Matches pi-ai's OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH. */
const PROMPT_CACHE_KEY_MAX_LENGTH = 64;

const LineageHeader = Schema.Struct({
  type: Schema.Literal("session"),
  id: Schema.String.check(Schema.isMinLength(1)),
  parentSession: Schema.optional(Schema.String),
});

const decodeLineageHeader = Schema.decodeUnknownOption(LineageHeader);

const ProviderPayload = Schema.Record(Schema.String, Schema.Unknown);
export type ProviderPayload = typeof ProviderPayload.Type;
const decodeProviderPayload = Schema.decodeUnknownOption(ProviderPayload);

const PROMPT_CACHE_KEY_FIELDS = ["prompt_cache_key", "promptCacheKey"] as const;

async function readLineageHeader(sessionFile: string) {
  let handle;
  try {
    handle = await open(sessionFile, "r");
  } catch {
    return undefined;
  }
  try {
    const buffer = Buffer.alloc(HEADER_SCAN_LIMIT);
    const { bytesRead } = await handle.read(buffer, 0, HEADER_SCAN_LIMIT, 0);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    const newline = text.indexOf("\n");
    if (newline === -1) return undefined;
    const parsed: unknown = JSON.parse(text.slice(0, newline));
    return Option.getOrUndefined(decodeLineageHeader(parsed));
  } catch {
    return undefined;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * Resolves the root ancestor session ID by following `parentSession` headers.
 * Stops at the nearest readable ancestor when a file is missing or outside the
 * session root, so a fork whose source was deleted keeps a stable key of its own.
 */
export async function resolvePromptCacheLineageKey(input: {
  sessionManager: SessionManager;
  sessionRoot: string;
}): Promise<string> {
  const header = input.sessionManager.getHeader();
  let key = input.sessionManager.getSessionId();
  let next = header?.parentSession;
  const visited = new Set<string>();
  const ownFile = input.sessionManager.getSessionFile();
  if (ownFile) visited.add(resolve(ownFile));
  for (let depth = 0; next && depth < MAX_LINEAGE_DEPTH; depth += 1) {
    const path = resolve(next);
    if (visited.has(path)) break;
    visited.add(path);
    try {
      assertSessionPath(path, input.sessionRoot, "Parent session file");
    } catch {
      break;
    }
    const ancestor = await readLineageHeader(path);
    if (!ancestor) break;
    key = ancestor.id;
    next = ancestor.parentSession;
  }
  return key;
}

/**
 * Replaces the prompt cache key fields pi-ai derived from this session's own
 * ID with the lineage key. Payloads for providers without a key, or with
 * caching disabled, are returned unchanged.
 */
export function applyPromptCacheLineageKey(
  payload: ProviderPayload,
  ownSessionId: string,
  lineageKey: string,
): ProviderPayload {
  if (lineageKey === ownSessionId) return payload;
  const clamped = Array.from(lineageKey).slice(0, PROMPT_CACHE_KEY_MAX_LENGTH).join("");
  let next: ProviderPayload | undefined;
  for (const field of PROMPT_CACHE_KEY_FIELDS) {
    if (payload[field] !== ownSessionId) continue;
    next = { ...(next ?? payload), [field]: clamped };
  }
  return next ?? payload;
}

export interface PromptCacheLineage {
  readonly extension: InlineExtension;
  /** Resolves and activates the lineage key for the session this runtime serves. */
  attach(input: { sessionManager: SessionManager; sessionRoot: string }): Promise<void>;
  key(): string | undefined;
}

export function createPromptCacheLineage(): PromptCacheLineage {
  let ownSessionId: string | undefined;
  let lineageKey: string | undefined;
  return {
    extension: (pi) => {
      pi.on("before_provider_request", (event) => {
        if (!ownSessionId || !lineageKey) return event.payload;
        const payload = decodeProviderPayload(event.payload);
        return Option.isSome(payload)
          ? applyPromptCacheLineageKey(payload.value, ownSessionId, lineageKey)
          : event.payload;
      });
    },
    async attach(input) {
      ownSessionId = input.sessionManager.getSessionId();
      lineageKey = await resolvePromptCacheLineageKey(input);
    },
    key: () => lineageKey,
  };
}
