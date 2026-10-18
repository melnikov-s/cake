import type { SessionContextMetadata } from "../contracts/conversations/session-context-metadata";

interface ModelMessage {
  readonly role: string;
  readonly timestamp: number;
  readonly provider?: string;
  readonly stopReason?: string;
  readonly usage?: {
    readonly cacheRead: number;
    readonly cacheWrite: number;
    readonly cacheWrite1h?: number;
  };
}

/** Input must be the active model projection, not retained display/history originals. */
export function modelActivityMetadata(messages: readonly ModelMessage[]) {
  const last = messages.findLast((message) => message.role === "assistant");
  const timestamp = last?.timestamp;
  const lastModelActivityAt =
    timestamp !== undefined && Number.isFinite(timestamp) && timestamp >= 0
      ? new Date(timestamp).toISOString()
      : undefined;
  const prefixChanged = messages.some(
    (message) => message.role === "system" && message.timestamp > (timestamp ?? -1),
  );
  const usage = last?.usage;
  return {
    ...(lastModelActivityAt ? { lastModelActivityAt } : null),
    ...(!prefixChanged &&
    lastModelActivityAt &&
    last?.provider &&
    last.stopReason !== "error" &&
    last.stopReason !== "aborted" &&
    usage &&
    usage.cacheRead + usage.cacheWrite > 0
      ? {
          cacheObservation: {
            provider: last.provider,
            observedAt: lastModelActivityAt,
            readTokens: usage.cacheRead,
            writeTokens: usage.cacheWrite,
            ...(usage.cacheWrite1h !== undefined ? { write1hTokens: usage.cacheWrite1h } : null),
          },
        }
      : null),
  };
}

export function sessionContextCost(metadata: SessionContextMetadata | undefined, now: number) {
  const base = {
    ...(metadata ? { estimatedTokens: metadata.estimatedTokens } : null),
    ...(metadata?.lastModelActivityAt
      ? { lastModelActivityAt: metadata.lastModelActivityAt }
      : null),
  };
  const observed = metadata?.cacheObservation;
  if (!observed) return { ...base, cache: "unknown" as const };
  const at = Date.parse(observed.observedAt);
  if (!Number.isFinite(at) || at > now) return { ...base, cache: "unknown" as const };

  // Pi records Anthropic/Bedrock's actual 1h creation-token split. A read alone
  // does not reveal its TTL, nor does today's PI_CACHE_RETENTION reveal an old request's TTL.
  // Anthropic documents 5m/1h lifetimes measured from request start (message.timestamp):
  // https://platform.claude.com/docs/en/build-with-claude/prompt-caching
  const anthropic = observed.provider === "anthropic" || observed.provider === "amazon-bedrock";
  if (
    anthropic &&
    observed.writeTokens > 0 &&
    observed.write1hTokens !== undefined &&
    observed.write1hTokens <= observed.writeTokens
  ) {
    const ttl = observed.write1hTokens === observed.writeTokens ? 60 * 60_000 : 5 * 60_000;
    const expiry = at + ttl;
    return {
      ...base,
      cache: now < expiry ? ("warm" as const) : ("potentially-expired" as const),
      estimatedExpiresAt: new Date(expiry).toISOString(),
    };
  }
  // Recent observed reuse/creation is only a warmth hint. No model-name TTL
  // inference: OpenAI retention/routing and third-party providers remain unknown.
  // OpenAI documents model/mode-dependent inactivity ranges, not one universal TTL:
  // https://developers.openai.com/api/docs/guides/prompt-caching
  return {
    ...base,
    cache: now - at < 5 * 60_000 ? ("warm" as const) : ("unknown" as const),
  };
}
