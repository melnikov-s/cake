import { describe, expect, it } from "vitest";
import {
  estimateContextTokens,
  formatEstimatedContextTokens,
} from "../../../src/renderer/lib/context-token-estimate";

describe("Browse context token estimate", () => {
  it("counts outline text and summary payloads, not labels, provenance or summarized originals", () => {
    expect(
      estimateContextTokens([
        { id: "system", title: "System prompt", source: "/not/context", text: "abcd" },
        { id: "instructions", title: "AGENTS.md", text: "efgh" },
        { id: "tools", title: "Tools", text: '{"name":"read"}' },
        {
          id: "messages",
          title: "Messages",
          children: [{ id: "recent", title: "You", kind: "original", text: "ijkl" }],
        },
        {
          id: "memory",
          title: "Memory",
          children: [
            {
              id: "summary",
              title: "mnop",
              kind: "summary",
              detail: { entryId: "history" },
              children: [{ id: "old", title: "You", kind: "original", text: "x".repeat(10_000) }],
            },
          ],
        },
      ]),
    ).toBe(8); // 31 characters, rounded up once after totaling all current text.
  });

  it("handles empty data and non-content group/role labels without inventing tokens", () => {
    expect(estimateContextTokens([])).toBe(0);
    expect(
      estimateContextTokens([
        { id: "empty", title: "System prompt", text: "" },
        { id: "group", title: "Memory", children: [] },
        { id: "missing", title: "Assistant", kind: "original" },
      ]),
    ).toBe(0);
  });

  it("rounds the total rather than each small source", () => {
    expect(
      estimateContextTokens([
        { id: "a", title: "A", text: "a" },
        { id: "b", title: "B", text: "b" },
      ]),
    ).toBe(1);
  });

  it.each([
    [0, "≈0 tokens"],
    [1, "≈1 token"],
    [999, "≈999 tokens"],
    [1_000, "≈1k tokens"],
    [1_234, "≈1.2k tokens"],
    [42_000, "≈42k tokens"],
    [999_999, "≈1m tokens"],
    [1_250_000, "≈1.3m tokens"],
  ])("formats %s as an explicitly approximate compact count", (tokens, expected) => {
    expect(formatEstimatedContextTokens(tokens)).toBe(expected);
  });
});
