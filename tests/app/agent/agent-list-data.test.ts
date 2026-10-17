import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  AgentListInput,
  agentListLabel,
  agentListPage,
} from "../../../src/contracts/agent/agent-list-data";

const decode = Schema.decodeUnknownSync(AgentListInput, { onExcessProperty: "error" });

describe("agent discovery pages", () => {
  const items = Array.from({ length: 61 }, (_, index) => ({ id: `item-${index}` }));

  it("defaults to 20 items with explicit continuation", () => {
    expect(agentListPage(items, decode({}))).toEqual({
      items: items.slice(0, 20),
      total: 61,
      offset: 0,
      nextOffset: 20,
    });
  });

  it("accepts the maximum and ends without a continuation", () => {
    const first = agentListPage(items, decode({ limit: 50 }));
    const last = agentListPage(items, decode({ limit: 50, offset: first.nextOffset }));
    expect(first.items).toHaveLength(50);
    expect(last).toEqual({ items: items.slice(50), total: 61, offset: 50, nextOffset: null });
  });

  it.each([{ values: [] }, { values: items.slice(0, 2) }])(
    "returns a complete small or empty page",
    ({ values }) => {
      expect(agentListPage(values, {})).toEqual({
        items: values,
        total: values.length,
        offset: 0,
        nextOffset: null,
      });
    },
  );

  it("preserves a filtered catalog's order and supports an exhausted offset", () => {
    const filtered = items.filter((_, index) => index % 2 === 0);
    expect(agentListPage(filtered, { offset: 10, limit: 2 }).items).toEqual([items[20], items[22]]);
    expect(agentListPage(filtered, { offset: 100 })).toEqual({
      items: [],
      total: 31,
      offset: 100,
      nextOffset: null,
    });
  });

  it.each([
    { limit: 0 },
    { limit: 51 },
    { limit: 1.5 },
    { offset: -1 },
    { offset: 0.5 },
    { query: "" },
    { query: "x".repeat(257) },
    { extra: true },
  ])("rejects invalid page input %j", (input) => {
    expect(() => decode(input)).toThrow();
  });

  it("bounds display labels without changing short labels", () => {
    expect(agentListLabel("Fix login")).toBe("Fix login");
    expect(agentListLabel("a".repeat(300))).toBe(`${"a".repeat(255)}…`);
  });
});
