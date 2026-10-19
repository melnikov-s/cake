/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Client } from "../../../src/renderer/client/Client";
import {
  cacheNow,
  cacheResponse,
  cacheSessionId,
  renderPromptCache,
} from "./prompt-cache-workflow-fixture";

const gauge = () => screen.getByLabelText(/context used;/);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(cacheNow);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("Prompt cache advisory in shared Chat", () => {
  it("shows one usage tooltip with full accounting and cache details, without a competing native title", () => {
    using fixture = renderPromptCache(
      cacheResponse({
        provider: "anthropic",
        modelId: "claude",
        requestedAt: cacheNow - 60_000,
        cacheReadTokens: 12_000,
      }).response,
    );
    void fixture;
    const target = gauge();
    expect(target.closest("[title]")).toBeNull();
    expect(target.querySelector("[title]")).toBeNull();
    expect(target.getAttribute("aria-label")).toContain("Cache estimated 4:00");
    const detail = target.getAttribute("aria-description");
    expect(detail).toContain("12,100 of 200,000 context tokens");
    expect(detail).toContain("12,110 billed tokens");
    expect(detail).toContain("Cache estimated 4:00");
    fireEvent.mouseEnter(target);
    act(() => vi.advanceTimersByTime(120));
    expect(screen.getAllByRole("tooltip")).toHaveLength(1);
    expect(screen.getByRole("tooltip").textContent).toBe(detail);
    fireEvent.mouseLeave(target);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });
  // Provider-response authority and virtual time drive this projection workflow.
  // This does not claim to test provider caching itself or native tooltip hover.
  it.each([
    {
      name: "Anthropic five-minute retention",
      response: cacheResponse({
        provider: "anthropic",
        modelId: "claude",
        requestedAt: cacheNow - 60_000,
        cacheReadTokens: 12_000,
      }).response,
      countdown: "Cache estimated 4:00",
      remaining: 4 * 60_000,
      expired: "Cache expired",
    },
    {
      name: "Anthropic one-hour retention",
      response: cacheResponse({
        provider: "anthropic",
        modelId: "claude",
        requestedAt: cacheNow - 30 * 60_000,
        cacheReadTokens: 12_000,
        retention: "long",
      }).response,
      countdown: "Cache estimated 30:00",
      remaining: 30 * 60_000,
      expired: "Cache expired",
    },
    {
      name: "OpenAI GPT-5.6 thirty-minute retention",
      response: cacheResponse({
        provider: "openai-codex",
        modelId: "gpt-5.6-sol",
        requestedAt: cacheNow - 6 * 60_000,
        inputTokens: 12_000,
      }).response,
      countdown: "Cache estimated 24:00",
      remaining: 24 * 60_000,
      expired: "Cache likely expired",
    },
  ])(
    "counts down and expires $name in the usage gauge",
    ({ response, countdown, remaining, expired }) => {
      using fixture = renderPromptCache(response);
      void fixture;
      expect(gauge().getAttribute("aria-label")).toContain(countdown);
      expect(gauge().getAttribute("data-cache-state")).toBe("likely-warm");

      act(() => vi.advanceTimersByTime(remaining));
      expect(gauge().getAttribute("aria-label")).toContain(expired);
      expect(gauge().getAttribute("data-cache-state")).toBe("likely-cold");
    },
  );

  it("explains the uncertain eviction window for earlier OpenAI models", () => {
    using fixture = renderPromptCache(
      cacheResponse({
        provider: "openai",
        modelId: "gpt-5.4",
        requestedAt: cacheNow - 6 * 60_000,
        inputTokens: 12_000,
      }).response,
    );
    void fixture;
    expect(gauge().getAttribute("data-cache-state")).toBe("uncertain");
    expect(gauge().getAttribute("aria-label")).toContain("Cache uncertain");
    expect(gauge().getAttribute("aria-label")).toContain("5–10 minutes");
  });

  it("invalidates the estimate after user-requested compaction and starts a fresh estimate on the next response", async () => {
    // No elapsed-time behavior is tested here; real event scheduling avoids coupling
    // user-event's async wrappers to the virtual countdown clock used above.
    vi.useRealTimers();
    const response = cacheResponse({
      provider: "anthropic",
      modelId: "claude",
      requestedAt: Date.now() - 60_000,
      cacheReadTokens: 12_000,
    });
    const compact = vi.fn<Client["sessionChats"]["compact"]>(async () => {
      fixture.publish([
        response,
        { id: "compaction", kind: "compaction", summary: "Earlier context", tokensBefore: 12_100 },
      ]);
    });
    using fixture = renderPromptCache(response.response, { sessionChats: { compact } });
    expect(gauge().getAttribute("data-cache-state")).toBe("likely-warm");
    await fixture.user.type(screen.getByRole("combobox", { name: "Message" }), "/compact");
    await fixture.user.click(screen.getByRole("button", { name: "Send" }));
    expect(compact).toHaveBeenCalledWith(
      { sessionId: cacheSessionId, instructions: undefined },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(gauge().getAttribute("data-cache-state")).toBe("unknown");
    expect(gauge().getAttribute("aria-label")).toContain("Cache status unavailable");

    fixture.publish([
      response,
      { id: "compaction", kind: "compaction", summary: "Earlier context", tokensBefore: 12_100 },
      cacheResponse({ ...response.response, requestedAt: Date.now() }, "fresh-response"),
    ]);
    expect(gauge().getAttribute("data-cache-state")).toBe("likely-warm");
    expect(gauge().getAttribute("aria-label")).toContain("Cache estimated");
  });

  it.each([
    {
      name: "an Anthropic response without cache usage",
      response: cacheResponse({
        provider: "anthropic",
        modelId: "claude",
        requestedAt: cacheNow - 60_000,
      }).response,
    },
    {
      name: "a provider without a supported cache policy",
      response: cacheResponse({
        provider: "google",
        modelId: "gemini",
        requestedAt: cacheNow - 60_000,
        cacheReadTokens: 12_000,
      }).response,
    },
  ])("does not advertise a warm cache for $name", ({ response }) => {
    using fixture = renderPromptCache(response);
    void fixture;
    expect(gauge().getAttribute("data-cache-state")).toBe("unknown");
    expect(gauge().getAttribute("aria-label")).toContain("Cache status unavailable");
  });
});
