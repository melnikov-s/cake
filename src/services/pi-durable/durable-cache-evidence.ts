import { Option, Schema } from "effect";
import type { CakeChatCacheRequest } from "../../contracts/cake-chats/context-policy";

type CacheEvidence = Pick<
  CakeChatCacheRequest,
  "resolvedRetention" | "cacheWrite5mTokens" | "cacheWrite1hTokens"
>;

const record = Schema.Record(Schema.String, Schema.Unknown);
const control = Schema.Struct({
  type: Schema.Literal("ephemeral"),
  ttl: Schema.optionalKey(Schema.Literals(["5m", "1h"])),
});
const count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const usage = Schema.Struct({
  cache_creation: Schema.optionalKey(
    Schema.Struct({
      ephemeral_5m_input_tokens: Schema.optionalKey(count),
      ephemeral_1h_input_tokens: Schema.optionalKey(count),
    }),
  ),
});
const eventUsage = Schema.Struct({
  usage: Schema.optionalKey(usage),
  message: Schema.optionalKey(Schema.Struct({ usage: Schema.optionalKey(usage) })),
});

/** Capture only structured cache evidence, never request bodies or environment secrets.
 * onPayload runs inside the installed adapter, after ModelRuntime's credential/env
 * resolution and provider defaults/compatibility. Missing callbacks stay unknown. */
export function durableCacheEvidence(api: string) {
  let resolvedRetention: CakeChatCacheRequest["resolvedRetention"];
  let cacheWrite5mTokens: number | undefined;
  let cacheWrite1hTokens: number | undefined;
  return {
    payload(payload: unknown) {
      if (!Schema.is(record)(payload)) return;
      if (api === "anthropic-messages") {
        const ttls = new Set<"5m" | "1h">();
        const visit = (value: unknown): void => {
          if (Array.isArray(value)) {
            value.forEach(visit);
            return;
          }
          if (!Schema.is(record)(value)) return;
          const decoded = Schema.decodeUnknownOption(control)(value.cache_control);
          if (Option.isSome(decoded)) ttls.add(decoded.value.ttl ?? "5m");
          // Content blocks are shallow; never traverse tool inputs or schemas.
        };
        // Only protocol-owned blocks, not tool schemas or arbitrary user data.
        for (const key of ["system", "messages", "tools"]) {
          const blocks = payload[key];
          if (!Array.isArray(blocks)) continue;
          for (const block of blocks) {
            if (!Schema.is(record)(block)) continue;
            if (key === "messages") visit(block.content);
            else {
              const decoded = Schema.decodeUnknownOption(control)(block.cache_control);
              if (Option.isSome(decoded)) ttls.add(decoded.value.ttl ?? "5m");
            }
          }
        }
        resolvedRetention = {
          source: "provider-payload",
          enabled: ttls.size > 0,
          anthropic5m: ttls.has("5m"),
          anthropic1h: ttls.has("1h"),
        };
      } else if (api === "bedrock-converse-stream") {
        const ttls = new Set<string>();
        const visit = (value: unknown): void => {
          if (Array.isArray(value)) {
            value.forEach(visit);
            return;
          }
          if (!Schema.is(record)(value)) return;
          const point = value.cachePoint;
          if (Schema.is(record)(point) && point.type === "default")
            ttls.add(Schema.is(Schema.String)(point.ttl) ? point.ttl : "5m");
          if (Array.isArray(value.content)) visit(value.content);
        };
        visit(payload.system);
        visit(payload.messages);
        if (ttls.size > 0)
          resolvedRetention = {
            source: "provider-payload",
            enabled: true,
            bedrock5m: ttls.has("5m"),
            bedrock1h: ttls.has("1h"),
          };
        // No cache points does not disable Nova's automatic caching.
      } else if (
        api === "openai-responses" ||
        api === "openai-completions" ||
        api === "openai-codex-responses"
      ) {
        // Absence of routing/retention fields is NOT evidence that OpenAI caching is off.
        const options = payload.prompt_cache_options;
        if (Schema.is(record)(options)) {
          const ttl = Schema.is(Schema.String)(options.ttl) ? options.ttl : undefined;
          const mode = Schema.is(Schema.String)(options.mode) ? options.mode : undefined;
          if (ttl || mode)
            resolvedRetention = {
              source: "provider-payload",
              enabled: mode !== "explicit",
            };
          if (resolvedRetention) {
            if (ttl) Object.assign(resolvedRetention, { openaiTtl: ttl });
            if (mode) Object.assign(resolvedRetention, { openaiMode: mode });
          }
        }
        if (Schema.is(Schema.String)(payload.prompt_cache_retention)) {
          resolvedRetention ??= { source: "provider-payload", enabled: true };
          Object.assign(resolvedRetention, { openaiRetention: payload.prompt_cache_retention });
        }
      }
    },
    event(event: unknown) {
      if (
        api === "bedrock-converse-stream" &&
        Schema.is(record)(event) &&
        Schema.is(record)(event.metadata)
      ) {
        const decoded = Schema.decodeUnknownOption(
          Schema.Struct({
            usage: Schema.Struct({
              cacheDetails: Schema.Array(
                Schema.Struct({ ttl: Schema.String, inputTokens: Schema.optionalKey(count) }),
              ),
            }),
          }),
        )(event.metadata);
        if (Option.isSome(decoded)) {
          const details = decoded.value.usage.cacheDetails;
          cacheWrite5mTokens = details
            .filter((detail) => detail.ttl === "5m")
            .reduce((n, detail) => n + (detail.inputTokens ?? 0), 0);
          cacheWrite1hTokens = details
            .filter((detail) => detail.ttl === "1h")
            .reduce((n, detail) => n + (detail.inputTokens ?? 0), 0);
        }
      }
      if (api !== "anthropic-messages") return;
      const decoded = Schema.decodeUnknownOption(eventUsage)(event);
      if (Option.isNone(decoded)) return;
      const creation = (decoded.value.usage ?? decoded.value.message?.usage)?.cache_creation;
      if (creation?.ephemeral_5m_input_tokens !== undefined)
        cacheWrite5mTokens = creation.ephemeral_5m_input_tokens;
      if (creation?.ephemeral_1h_input_tokens !== undefined)
        cacheWrite1hTokens = creation.ephemeral_1h_input_tokens;
    },
    snapshot() {
      const evidence: CacheEvidence = {};
      if (resolvedRetention) Object.assign(evidence, { resolvedRetention });
      if (cacheWrite5mTokens !== undefined) Object.assign(evidence, { cacheWrite5mTokens });
      if (cacheWrite1hTokens !== undefined) Object.assign(evidence, { cacheWrite1hTokens });
      return evidence;
    },
  };
}

/** Anthropic refreshes an accessed prefix's TTL. Reads are not split by TTL;
 * with mixed live prefixes we cannot attribute a read, so do not refresh either
 * clock. Creation counters are per-request, while these clocks are explicitly
 * heuristic and may describe only part of the next request's prefix. */
export function anthropicCacheEstimate(
  request: CakeChatCacheRequest,
  previous: CakeChatCacheRequest | undefined,
): CakeChatCacheRequest["anthropicEstimate"] {
  if (
    (request.api !== "anthropic-messages" && request.provider !== "anthropic") ||
    request.resolvedRetention?.enabled === false
  )
    return;
  const at = request.requestedAt;
  let fiveMinuteAt = previous?.anthropicEstimate?.fiveMinuteAt;
  let oneHourAt =
    previous?.anthropicEstimate?.oneHourAt ??
    ((previous?.cacheWrite1hTokens ?? 0) > 0 ? previous?.requestedAt : undefined);
  if (fiveMinuteAt !== undefined && (fiveMinuteAt > at || at - fiveMinuteAt >= 5 * 60_000))
    fiveMinuteAt = undefined;
  if (oneHourAt !== undefined && (oneHourAt > at || at - oneHourAt >= 60 * 60_000))
    oneHourAt = undefined;
  if (request.cacheReadTokens > 0) {
    if (oneHourAt !== undefined && fiveMinuteAt === undefined) oneHourAt = at;
    else if (fiveMinuteAt !== undefined && oneHourAt === undefined) fiveMinuteAt = at;
  }
  if ((request.cacheWrite1hTokens ?? 0) > 0) oneHourAt = at;
  // The adapter's aggregate creation count includes one-hour writes. Do not
  // relabel this subtraction as a reported five-minute creation counter.
  if (
    (request.cacheWrite5mTokens ?? request.cacheWriteTokens - (request.cacheWrite1hTokens ?? 0)) > 0
  ) {
    if (request.cacheWrite1hTokens === undefined && request.resolvedRetention?.anthropic1h)
      oneHourAt = at;
    else fiveMinuteAt = at;
  }
  if (fiveMinuteAt === undefined && oneHourAt === undefined) return;
  const estimate: NonNullable<CakeChatCacheRequest["anthropicEstimate"]> = {
    source: "creation-and-unallocated-read-estimate",
    confidence: "heuristic",
  };
  if (fiveMinuteAt !== undefined) Object.assign(estimate, { fiveMinuteAt });
  if (oneHourAt !== undefined) Object.assign(estimate, { oneHourAt });
  return estimate;
}
