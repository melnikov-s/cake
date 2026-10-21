import { describe, expect, it } from "vitest";
import { sessionRoster } from "../../../src/domain/application/sessionRoster";
import type { SessionContextMetadata } from "../../../src/contracts/conversations/session-context-metadata";

const a = "01957936-0000-7000-8000-000112345678";
const b = "01957936-0000-7000-8000-000212345678";
const at = Date.parse("2026-01-01T12:00:00Z");
const metadata: SessionContextMetadata = {
  estimatedTokens: 18_000,
  lastModelActivityAt: new Date(at).toISOString(),
  cacheObservation: {
    provider: "anthropic",
    observedAt: new Date(at).toISOString(),
    readTokens: 0,
    writeTokens: 1000,
    write1hTokens: 0,
  },
};
const row = {
  sessionId: a,
  title: "Implement search",
  status: "idle" as const,
  projectName: "My App",
  contextMetadata: metadata,
};
const page = { total: 1, nextOffset: null };

describe("LLM session roster", () => {
  it("uses one compact header, rounded tokens, relative freshness and a bare routable id", () => {
    expect(sessionRoster([row], page, [a], at + 120_000, false)).toBe(
      "1 sessions\nid status lifecycle outcome tokens cache age ttl | title\n12345678 idle active - 18K warm 2m 3m | Implement search",
    );
  });

  it("retains uncertainty next to an old large context, with elapsed estimated expiry", () => {
    expect(
      sessionRoster(
        [{ ...row, contextMetadata: { ...metadata, estimatedTokens: 145_000 } }],
        page,
        [a],
        at + 3_600_000,
        false,
      ),
    ).toContain("145K expired? 1h -55m");
    expect(sessionRoster([{ ...row, contextMetadata: undefined }], page, [a], at, false)).toContain(
      "idle active - ? ? ? ?",
    );
    expect(
      sessionRoster([{ ...row, contextMetadata: { estimatedTokens: 0 } }], page, [a], at, false),
    ).toContain("idle active - 0 ? ? ?");
  });

  it("shows project names only for cross-project discovery and preserves collision-safe references", () => {
    expect(sessionRoster([row], { total: 2, nextOffset: 1 }, [a, b], at, true)).toBe(
      "2 sessions; next=1\nid status lifecycle outcome tokens cache age ttl | project | title\n112345678 idle active - 18K warm 0s 5m | My App | Implement search",
    );
    expect(sessionRoster([], { total: 0, nextOffset: null }, [], at, false)).toBe("0 sessions");
  });

  it("keeps twenty rows below a small text budget and keeps multiline titles within their row", () => {
    const rows = Array.from({ length: 20 }, (_, index) => ({
      ...row,
      title: `Related task ${index}`,
    }));
    expect(
      sessionRoster(rows, { total: 20, nextOffset: null }, [a], at, false).length,
    ).toBeLessThan(1500);
    expect(
      sessionRoster(
        [{ ...row, title: "Title\nnot a new row | nor a column" }],
        page,
        [a],
        at,
        false,
      ).split("\n"),
    ).toHaveLength(3);
  });
});
