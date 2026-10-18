import { describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { SessionContextMetadata } from "../../../src/contracts/conversations/session-context-metadata";
import { projectSessionContextMetadata } from "../../../src/services/pi/runtime/session-context-metadata";
import { appendToolCompactedBranch } from "../../../src/services/pi/runtime/session-tool-compaction";
import { modelActivityMetadata, sessionContextCost } from "../../../src/utils/session-context-cost";

const at = Date.parse("2026-01-01T00:00:00Z");
const response = (overrides: Partial<AssistantMessage> = {}): AssistantMessage => ({
  role: "assistant",
  api: "anthropic-messages",
  provider: "anthropic",
  model: "fixture",
  timestamp: at,
  content: [{ type: "text", text: "Done" }],
  stopReason: "stop",
  usage: {
    input: 10,
    output: 1,
    totalTokens: 100_000,
    cacheRead: 0,
    cacheWrite: 1000,
    cacheWrite1h: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  ...overrides,
});
const metadata = (message = response()): SessionContextMetadata => ({
  estimatedTokens: 90_000,
  ...modelActivityMetadata([message]),
});

describe("advisory cache freshness", () => {
  it("shows both large size and evidenced estimated expiry, never a hit/miss", () => {
    expect(sessionContextCost(metadata(), at + 60_000)).toEqual({
      estimatedTokens: 90_000,
      lastModelActivityAt: new Date(at).toISOString(),
      cache: "warm",
      estimatedExpiresAt: new Date(at + 5 * 60_000).toISOString(),
    });
    expect(sessionContextCost(metadata(), at + 5 * 60_000)).toMatchObject({
      estimatedTokens: 90_000,
      cache: "potentially-expired",
    });
  });

  it.each(["anthropic", "amazon-bedrock"])(
    "uses recorded 1h creation evidence for %s",
    (provider) => {
      const short = response();
      const long = metadata(response({ provider, usage: { ...short.usage, cacheWrite1h: 1000 } }));
      expect(sessionContextCost(long, at + 30 * 60_000)).toMatchObject({
        cache: "warm",
        estimatedExpiresAt: new Date(at + 60 * 60_000).toISOString(),
      });
      expect(sessionContextCost(long, at + 60 * 60_000).cache).toBe("potentially-expired");
      const mixed = metadata(response({ provider, usage: { ...short.usage, cacheWrite1h: 500 } }));
      expect(sessionContextCost(mixed, at + 5 * 60_000).cache).toBe("potentially-expired");
    },
  );

  it("does not infer historical TTL from environment, a model name, reads or absent TTL usage", () => {
    const usage = response().usage;
    for (const provider of ["anthropic", "openai", "openai-codex", "custom"]) {
      const read = metadata(
        response({
          provider,
          model: "gpt-5.6",
          usage: { ...usage, cacheRead: 1000, cacheWrite: 0 },
        }),
      );
      expect(sessionContextCost(read, at + 1000)).toMatchObject({ cache: "warm" });
      expect(sessionContextCost(read, at + 60 * 60_000)).toMatchObject({ cache: "unknown" });
      expect(sessionContextCost(read, at + 1000)).not.toHaveProperty("estimatedExpiresAt");
    }
    const legacy = metadata(response({ usage: { ...usage, cacheWrite1h: undefined } }));
    expect(sessionContextCost(legacy, at + 1000)).not.toHaveProperty("estimatedExpiresAt");
  });

  it("preserves unknown and missing size, including failures and impossible future evidence", () => {
    expect(sessionContextCost(undefined, at)).toEqual({ cache: "unknown" });
    expect(sessionContextCost(metadata(response({ stopReason: "error" })), at)).toEqual({
      estimatedTokens: 90_000,
      lastModelActivityAt: new Date(at).toISOString(),
      cache: "unknown",
    });
    expect(sessionContextCost(metadata(), at - 1).cache).toBe("unknown");
    expect(
      sessionContextCost(
        metadata(response({ usage: { ...response().usage, cacheRead: 0, cacheWrite: 0 } })),
        at,
      ).cache,
    ).toBe("unknown");
  });
});

describe("regular Pi active-context size", () => {
  it("counts summaries and kept dialogue, not hidden originals or stale usage", () => {
    const manager = SessionManager.inMemory("/project");
    manager.appendMessage({ role: "user", content: "x".repeat(400_000), timestamp: at - 2 });
    manager.appendMessage(response());
    const kept = manager.appendMessage({
      role: "user",
      content: "Keep this request",
      timestamp: at + 1,
    });
    const original = projectSessionContextMetadata(manager);
    expect(original.estimatedTokens).toBeGreaterThan(100_000);
    manager.appendCompaction("Small summary", kept, 999_999);
    const compacted = projectSessionContextMetadata(manager);
    expect(compacted.estimatedTokens).toBeGreaterThan(0);
    expect(compacted.estimatedTokens).toBeLessThan(200);
    expect(compacted.lastModelActivityAt).toBe(new Date(at).toISOString());
    expect(sessionContextCost(compacted, at + 1000).cache).toBe("unknown");
  });

  it("excludes tool-compacted originals and cannot reuse replayed response cache evidence", () => {
    const manager = SessionManager.inMemory("/project");
    manager.appendMessage({ role: "user", content: "Inspect", timestamp: at - 2 });
    manager.appendMessage(
      response({
        content: [{ type: "toolCall", name: "read", id: "call", arguments: {} }],
        stopReason: "toolUse",
      }),
    );
    manager.appendMessage({
      role: "toolResult",
      toolName: "read",
      toolCallId: "call",
      content: [{ type: "text", text: "x".repeat(400_000) }],
      isError: false,
      timestamp: at,
    });
    const final = manager.appendMessage(
      response({ content: [{ type: "text", text: "Found the cause" }] }),
    );
    expect(projectSessionContextMetadata(manager).estimatedTokens).toBeGreaterThan(100_000);
    appendToolCompactedBranch(manager, final);
    const metadata = projectSessionContextMetadata(manager);
    expect(metadata.estimatedTokens).toBeLessThan(200);
    expect(sessionContextCost(metadata, at + 1000).cache).toBe("unknown");
  });

  it("counts system/tools and ignores bash explicitly excluded from model context", () => {
    const manager = SessionManager.inMemory("/project");
    manager.appendMessage({ role: "system", content: "a".repeat(400), timestamp: at - 2 });
    manager.appendMessage({ role: "user", content: "four", timestamp: at - 1 });
    const before = projectSessionContextMetadata(manager);
    manager.appendMessage({
      role: "bashExecution",
      command: "echo secret",
      output: "z".repeat(400_000),
      exitCode: 0,
      cancelled: false,
      truncated: false,
      excludeFromContext: true,
      timestamp: at,
    });
    expect(projectSessionContextMetadata(manager).estimatedTokens).toBe(before.estimatedTokens);
    expect(before.estimatedTokens).toBeGreaterThanOrEqual(101);
  });

  it("invalidates warmth after model or context changes without replacing model activity with file activity", () => {
    const manager = SessionManager.inMemory("/project");
    manager.appendMessage(response());
    manager.appendSessionInfo("Only a rename");
    expect(sessionContextCost(projectSessionContextMetadata(manager), at + 1000).cache).toBe(
      "warm",
    );
    manager.appendModelChange("openai", "gpt-5.6");
    expect(sessionContextCost(projectSessionContextMetadata(manager), at + 1000).cache).toBe(
      "unknown",
    );
    manager.appendMessage(response({ timestamp: at + 1000 }));
    expect(sessionContextCost(projectSessionContextMetadata(manager), at + 1000).cache).toBe(
      "warm",
    );
    manager.appendMessage({
      role: "system",
      content: "Changed instructions",
      timestamp: at + 2000,
    });
    expect(sessionContextCost(projectSessionContextMetadata(manager), at + 2000).cache).toBe(
      "unknown",
    );
  });
});
