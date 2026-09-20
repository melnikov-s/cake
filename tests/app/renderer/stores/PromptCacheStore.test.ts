import { createStore, mount } from "r-state-tree";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UiPart } from "../../../../src/ipc/session-contract";
import { PromptCacheStore } from "../../../../src/renderer/stores/PromptCacheStore";

const NOW = new Date("2026-01-01T12:00:00Z").getTime();

function responsePart(
  provider: string,
  modelId: string,
  requestedAt: number,
  usage: { input?: number; cacheRead?: number; cacheWrite?: number } = {},
  retention: "short" | "long" = "short",
): UiPart {
  return {
    id: "assistant",
    kind: "text",
    role: "assistant",
    text: "Done",
    status: "complete",
    response: {
      provider,
      modelId,
      retention,
      requestedAt,
      inputTokens: usage.input ?? 0,
      cacheReadTokens: usage.cacheRead ?? 0,
      cacheWriteTokens: usage.cacheWrite ?? 0,
    },
  };
}

function createPromptCacheStore(parts: UiPart[], provider: string, modelId: string) {
  return mount(
    createStore(PromptCacheStore, {
      parts: () => parts,
      model: () => ({ provider, modelId }),
    }),
  );
}

afterEach(() => {
  vi.useRealTimers();
});

describe("PromptCacheStore", () => {
  it("counts down Anthropic's confirmed five-minute cache window", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const store = createPromptCacheStore(
      [responsePart("anthropic", "claude", NOW - 60_000, { cacheRead: 12_000 })],
      "anthropic",
      "claude",
    );

    expect(store.prediction).toMatchObject({
      state: "likely-warm",
      label: "Cache estimated 4:00",
    });

    vi.advanceTimersByTime(4 * 60_000);
    expect(store.prediction).toMatchObject({ state: "likely-cold", label: "Cache expired" });
    store[Symbol.dispose]();
  });

  it("uses Anthropic's one-hour window when long retention is active", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const store = createPromptCacheStore(
      [responsePart("anthropic", "claude", NOW - 30 * 60_000, { cacheRead: 12_000 }, "long")],
      "anthropic",
      "claude",
    );

    expect(store.prediction).toMatchObject({
      state: "likely-warm",
      label: "Cache estimated 30:00",
    });
    store[Symbol.dispose]();
  });

  it("counts down OpenAI's 30-minute window for GPT-5.6 and later", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const store = createPromptCacheStore(
      [responsePart("openai-codex", "gpt-5.6-sol", NOW - 6 * 60_000, { input: 12_000 })],
      "openai-codex",
      "gpt-5.6-sol",
    );

    expect(store.prediction).toMatchObject({
      state: "likely-warm",
      label: "Cache estimated 24:00",
    });

    vi.advanceTimersByTime(24 * 60_000);
    expect(store.prediction).toMatchObject({
      state: "likely-cold",
      label: "Cache likely expired",
    });
    store[Symbol.dispose]();
  });

  it("uses OpenAI's documented 5–10 minute uncertainty window for earlier models", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const store = createPromptCacheStore(
      [responsePart("openai", "gpt-5.4", NOW - 6 * 60_000, { input: 12_000 })],
      "openai",
      "gpt-5.4",
    );

    expect(store.prediction).toMatchObject({ state: "uncertain", label: "Cache uncertain" });
    store[Symbol.dispose]();
  });

  it("invalidates an earlier estimate after compaction", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const store = createPromptCacheStore(
      [
        responsePart("anthropic", "claude", NOW - 60_000, { cacheRead: 12_000 }),
        {
          id: "compaction",
          kind: "compaction",
          summary: "Earlier context",
          tokensBefore: 12_000,
        },
      ],
      "anthropic",
      "claude",
    );

    expect(store.prediction).toBeUndefined();
    store[Symbol.dispose]();
  });

  it("does not claim caching without a cacheable provider response", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const anthropic = createPromptCacheStore(
      [responsePart("anthropic", "claude", NOW - 60_000)],
      "anthropic",
      "claude",
    );
    const unsupported = createPromptCacheStore(
      [responsePart("google", "gemini", NOW - 60_000, { cacheRead: 12_000 })],
      "google",
      "gemini",
    );

    expect(anthropic.prediction).toBeUndefined();
    expect(unsupported.prediction).toBeUndefined();
    anthropic[Symbol.dispose]();
    unsupported[Symbol.dispose]();
  });
});
