import { Schema } from "effect";

const tokens = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
export const CakeChatCacheRequest = Schema.Struct({
  provider: Schema.String,
  modelId: Schema.String,
  requestedAt: Schema.Number,
  retention: Schema.optionalKey(Schema.Literals(["none", "short", "long"])),
  inputTokens: tokens,
  cacheReadTokens: tokens,
  cacheWriteTokens: tokens,
});
export interface CakeChatCacheRequest extends Schema.Schema.Type<typeof CakeChatCacheRequest> {}

export const CakeChatSummary = Schema.Struct({
  beforeTokens: tokens,
  afterTokens: tokens,
  reason: Schema.Literals(["limit", "cache-cold", "cache-unknown"]),
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
  if (!request || request.requestedAt > now || request.retention === "none")
    return { state: "unknown" as const, detail: "No reliable matching cache request." };
  let lifetime = 5 * 60_000;
  let assumed = true;
  if (request.provider === "anthropic" || request.provider === "amazon-bedrock") {
    if (request.cacheReadTokens + request.cacheWriteTokens === 0)
      return { state: "unknown" as const, detail: "The provider reported no cached input." };
    lifetime = request.retention === "long" ? 60 * 60_000 : 5 * 60_000;
    assumed = false;
  } else if (request.provider === "openai" || request.provider === "openai-codex") {
    if (request.inputTokens + request.cacheReadTokens < 1_024)
      return {
        state: "unknown" as const,
        detail: "The reported input is below the provider’s cacheable prefix size.",
      };
    const version = /^gpt-(\d+)(?:\.(\d+))?(?:-|$)/.exec(request.modelId);
    if (
      version &&
      (Number(version[1]) > 5 || (Number(version[1]) === 5 && Number(version[2] ?? 0) >= 5))
    ) {
      lifetime = 30 * 60_000;
      assumed = false;
    } else if (request.retention !== "long") {
      const elapsed = now - request.requestedAt;
      if (elapsed >= 5 * 60_000 && elapsed < 10 * 60_000)
        return {
          state: "uncertain" as const,
          detail: "Provider eviction is uncertain after 5–10 minutes.",
        };
      if (elapsed >= 10 * 60_000)
        return { state: "likely-cold" as const, detail: "The estimated cache window has elapsed." };
      assumed = false;
    }
  }
  const expiresAt = request.requestedAt + lifetime;
  return {
    state: now < expiresAt ? ("likely-warm" as const) : ("likely-cold" as const),
    expiresAt,
    detail: `${assumed ? "Assumed" : "Estimated"} ${lifetime / 60_000}-minute retention from the last matching request. Reuse is not guaranteed.`,
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
