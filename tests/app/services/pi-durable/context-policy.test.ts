import { describe, expect, it } from "vitest";
import {
  cakeChatCacheFreshness,
  cakeChatSummaryReason,
  type CakeChatCacheRequest,
} from "../../../../src/contracts/cake-chats/context-policy";

const at = 1_000_000;
const request: CakeChatCacheRequest = {
  provider: "other",
  modelId: "example",
  requestedAt: at,
  inputTokens: 12_000,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

describe("Cake Chat cache-aware context policy", () => {
  it.each([
    ["other", "example", undefined, 5],
    ["anthropic", "claude", "short", 5],
    ["amazon-bedrock", "claude", "long", 60],
    ["openai", "gpt-5.6", "short", 30],
    ["openai-codex", "gpt-5.5-sol", "short", 30],
  ] as const)(
    "uses persisted request time for %s / %s",
    (provider, modelId, retention, minutes) => {
      const sample = {
        ...request,
        provider,
        modelId,
        ...(retention ? { retention } : {}),
        cacheReadTokens: 8_000,
      };
      const expires = at + minutes * 60_000;
      expect(cakeChatCacheFreshness(sample, expires - 1).state).toBe("likely-warm");
      expect(cakeChatCacheFreshness(sample, expires).state).toBe("likely-cold");
    },
  );

  it("summarizes at an uncertain OpenAI eviction window and when metadata is unavailable", () => {
    const cache = { ...request, provider: "openai", modelId: "gpt-5.4" };
    const status = { totalTokens: 15_000, limitTokens: 30_000, cache };
    expect(cakeChatSummaryReason(status, at + 4 * 60_000)).toBeUndefined();
    expect(cakeChatCacheFreshness(cache, at + 6 * 60_000).state).toBe("uncertain");
    expect(cakeChatSummaryReason(status, at + 6 * 60_000)).toBe("cache-unknown");
    expect(cakeChatSummaryReason({ ...status, cache: undefined }, at)).toBe("cache-unknown");
  });

  it("lets the hard effective limit override a warm cache", () => {
    expect(
      cakeChatSummaryReason({ totalTokens: 300_000, limitTokens: 300_000, cache: request }, at),
    ).toBe("limit");
    expect(
      cakeChatSummaryReason({ totalTokens: 299_999, limitTokens: 300_000, cache: request }, at),
    ).toBeUndefined();
  });

  it("does not claim warmth for a future timestamp, disabled caching, or a provider reporting no reusable prefix", () => {
    expect(cakeChatCacheFreshness(request, at - 1).state).toBe("unknown");
    expect(cakeChatCacheFreshness({ ...request, retention: "none" }, at).state).toBe("unknown");
    expect(cakeChatCacheFreshness({ ...request, provider: "anthropic" }, at).state).toBe("unknown");
    expect(
      cakeChatCacheFreshness({ ...request, provider: "openai", inputTokens: 12 }, at).state,
    ).toBe("unknown");
  });
});
