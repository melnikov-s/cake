import { Schema } from "effect";

const tokens = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
export const CakeChatCacheRequest = Schema.Struct({
  provider: Schema.String,
  modelId: Schema.String,
  api: Schema.optionalKey(Schema.String),
  requestedAt: Schema.Number,
  /** Requested option, not the provider's resolved policy. Absent in older records. */
  retention: Schema.optionalKey(Schema.Literals(["none", "short", "long"])),
  resolvedRetention: Schema.optionalKey(
    Schema.Struct({
      source: Schema.Literal("provider-payload"),
      enabled: Schema.Boolean,
      anthropic5m: Schema.optionalKey(Schema.Boolean),
      anthropic1h: Schema.optionalKey(Schema.Boolean),
      openaiRetention: Schema.optionalKey(Schema.String),
      openaiTtl: Schema.optionalKey(Schema.String),
      openaiMode: Schema.optionalKey(Schema.String),
      bedrock5m: Schema.optionalKey(Schema.Boolean),
      bedrock1h: Schema.optionalKey(Schema.Boolean),
    }),
  ),
  completedAt: Schema.optionalKey(Schema.Number),
  cacheWrite1hTokens: Schema.optionalKey(tokens),
  cacheWrite5mTokens: Schema.optionalKey(tokens),
  /** Partial-prefix, rolling-access estimates; never provider-confirmed expiry. */
  anthropicEstimate: Schema.optionalKey(
    Schema.Struct({
      source: Schema.Literal("creation-and-unallocated-read-estimate"),
      confidence: Schema.Literal("heuristic"),
      fiveMinuteAt: Schema.optionalKey(Schema.Number),
      oneHourAt: Schema.optionalKey(Schema.Number),
    }),
  ),
  inputTokens: tokens,
  cacheReadTokens: tokens,
  cacheWriteTokens: tokens,
});
export interface CakeChatCacheRequest extends Schema.Schema.Type<typeof CakeChatCacheRequest> {}

export const CakeChatSummary = Schema.Struct({
  beforeTokens: tokens,
  afterTokens: tokens,
  reason: Schema.Literals(["limit", "cache-cold", "cache-unknown", "overflow"]),
  completedAt: Schema.Number,
});
export const CakeChatContextStatus = Schema.Struct({
  systemTokens: tokens,
  memoryTokens: tokens,
  messageTokens: tokens,
  totalTokens: tokens,
  limitTokens: Schema.Int.check(Schema.isGreaterThan(0)),
  configuredLimitTokens: Schema.Int.check(Schema.isGreaterThan(0)),
  modelLimitTokens: Schema.Int.check(Schema.isGreaterThan(0)),
  cache: Schema.optionalKey(CakeChatCacheRequest),
  activity: Schema.optionalKey(Schema.Literals(["summarizing", "consolidating"])),
  lastSummary: Schema.optionalKey(CakeChatSummary),
});
export interface CakeChatContextStatus extends Schema.Schema.Type<typeof CakeChatContextStatus> {}

/** Advisory freshness, never an assertion that a provider will reuse a prefix. */
export function cakeChatCacheFreshness(request: CakeChatCacheRequest | undefined, now: number) {
  if (
    !request ||
    request.requestedAt > now ||
    request.resolvedRetention?.enabled === false ||
    (!request.resolvedRetention && request.retention === "none")
  )
    return { state: "unknown" as const, detail: "No reliable matching cache request." };
  let lifetime = 5 * 60_000;
  let assumed = true;
  if (request.api === "anthropic-messages" || request.provider === "anthropic") {
    const estimate = request.anthropicEstimate;
    const longAt =
      estimate?.oneHourAt ??
      ((request.cacheWrite1hTokens ?? 0) > 0 ? request.requestedAt : undefined);
    const shortAt = estimate?.fiveMinuteAt;
    const expiry = Math.max(
      longAt !== undefined && longAt <= now ? longAt + 60 * 60_000 : 0,
      shortAt !== undefined && shortAt <= now ? shortAt + 5 * 60_000 : 0,
    );
    if (expiry > 0)
      return {
        state: now < expiry ? ("likely-warm" as const) : ("likely-cold" as const),
        expiresAt: expiry,
        detail:
          "Estimated retention of an observed partial prefix. Reads refresh Anthropic TTLs, but unallocated mixed-TTL reads do not identify which prefix was refreshed. Reuse is not guaranteed; elapsed time is not proven eviction.",
      };
    if (request.cacheReadTokens + request.cacheWriteTokens === 0)
      return { state: "unknown" as const, detail: "The provider reported no cached input." };
    lifetime =
      request.resolvedRetention?.anthropic1h ||
      (!request.resolvedRetention && request.retention === "long")
        ? 60 * 60_000
        : 5 * 60_000;
  } else if (request.provider === "amazon-bedrock") {
    if (request.cacheReadTokens + request.cacheWriteTokens === 0)
      return { state: "unknown" as const, detail: "The provider reported no cached input." };
    lifetime =
      (request.cacheWrite1hTokens ?? 0) > 0 ||
      request.resolvedRetention?.bedrock1h ||
      (!request.resolvedRetention && request.retention === "long")
        ? 60 * 60_000
        : 5 * 60_000;
    assumed = false;
  } else if (request.provider === "openai" || request.provider === "openai-codex") {
    if (request.inputTokens + request.cacheReadTokens < 1_024)
      return {
        state: "unknown" as const,
        detail: "The reported input is below the provider’s cacheable prefix size.",
      };
    const version = /^gpt-(\d+)(?:\.(\d+))?(?:-|$)/.exec(request.modelId);
    if (
      request.resolvedRetention?.openaiTtl === "30m" ||
      (version &&
        (Number(version[1]) > 5 || (Number(version[1]) === 5 && Number(version[2] ?? 0) >= 5)))
    ) {
      lifetime = 30 * 60_000;
    } else if (request.retention !== "long") {
      const elapsed = now - request.requestedAt;
      if (elapsed >= 5 * 60_000 && elapsed < 10 * 60_000)
        return {
          state: "uncertain" as const,
          detail: "Provider eviction is uncertain after 5–10 minutes.",
        };
      if (elapsed >= 10 * 60_000)
        return { state: "likely-cold" as const, detail: "The estimated cache window has elapsed." };
    }
  }
  const expiresAt = request.requestedAt + lifetime;
  return {
    state: now < expiresAt ? ("likely-warm" as const) : ("likely-cold" as const),
    expiresAt,
    detail: `${assumed ? "Assumed" : "Estimated"} ${lifetime / 60_000}-minute retention from the last matching request. Partial-prefix reuse is not guaranteed; elapsed time is not proven eviction.`,
  };
}

export function cakeChatSummaryReason(
  status: Pick<CakeChatContextStatus, "totalTokens" | "limitTokens" | "cache">,
  now: number,
) {
  if (status.totalTokens >= status.limitTokens) return "limit" as const;
  if (status.totalTokens === 0) return undefined;
  const cache = cakeChatCacheFreshness(status.cache, now);
  if (cache.state === "likely-warm") return undefined;
  return cache.state === "likely-cold" ? ("cache-cold" as const) : ("cache-unknown" as const);
}
