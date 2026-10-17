import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import type { BoardEntry } from "../../../src/contracts/artifacts/message-board";
import {
  BoardContinuationInput,
  type BoardContinuation,
} from "../../../src/contracts/artifacts/workboard-continuation";
import { continuationEntries } from "../../../src/domain/session-families/workboardContinuations";

const grant: BoardContinuation = {
  recipientSessionId: "parent",
  boardId: "board",
  authorizationId: "grant",
  mode: "resume",
  awaitAuthors: [],
  completedAuthors: [],
  remainingTurns: 1,
  after: 0,
};
const entry = (sequence: number, fields: Partial<BoardEntry> = {}): BoardEntry => ({
  sequence,
  authorSessionId: "child",
  audience: ["parent"],
  topic: "batch",
  description: "Result",
  body: "Evidence",
  createdAt: "2026-01-01",
  event: "completion",
  ...fields,
});

describe("Workboard continuation selection", () => {
  it("ignores prose, links, broadcasts, other recipients, self, old events and other topics", () => {
    const entries = [
      entry(1),
      entry(2, { event: undefined, body: "[Done](cake://session/child)" }),
      entry(3, { audience: "workgroup" }),
      entry(4, { audience: ["sibling"] }),
      entry(5, { authorSessionId: "parent" }),
      entry(6, { topic: "unrelated" }),
      entry(7, { authorSessionId: "other" }),
    ];
    expect(
      continuationEntries({ ...grant, topic: "batch", after: 1, awaitAuthors: ["child"] }, entries),
    ).toEqual([]);
  });
  it("coalesces the latest live event per author and excludes explicitly superseded results", () => {
    const entries = [entry(1), entry(2, { event: "blocker" }), entry(3, { supersedes: [1, 2] })];
    expect(continuationEntries(grant, entries).map((e) => e.sequence)).toEqual([3]);
  });
  it("waits for all authors, except for a current blocker, and remembers completions from a prior blocker turn", () => {
    const batch = { ...grant, topic: "batch", awaitAuthors: ["a", "b"] };
    expect(continuationEntries(batch, [entry(1, { authorSessionId: "a" })])).toEqual([]);
    expect(
      continuationEntries(batch, [entry(1, { authorSessionId: "b", event: "blocker" })]),
    ).toHaveLength(1);
    expect(
      continuationEntries({ ...batch, after: 2, completedAuthors: ["a"] }, [
        entry(3, { authorSessionId: "b" }),
      ]),
    ).toHaveLength(1);
    // An obsolete blocker is not a reason to bypass a still-incomplete batch.
    expect(
      continuationEntries(batch, [
        entry(1, { authorSessionId: "a", event: "blocker" }),
        entry(2, { authorSessionId: "a" }),
      ]),
    ).toEqual([]);
  });
  it("limits one inspection to twenty coalesced entries", () => {
    expect(
      continuationEntries(
        grant,
        Array.from({ length: 25 }, (_, i) => entry(i + 1, { authorSessionId: "child-" + i })),
      ),
    ).toHaveLength(20);
  });
  it("requires positive finite turn and batch bounds", () => {
    for (const input of [
      { mode: "resume", maxTurns: 0 },
      { mode: "resume", maxTurns: 11 },
      { mode: "resume", awaitAuthors: Array(21).fill("child") },
      { mode: "resume", after: -1 },
    ]) {
      expect(() => Schema.decodeUnknownSync(BoardContinuationInput)(input)).toThrow();
    }
    expect(Schema.decodeUnknownSync(BoardContinuationInput)({ mode: "paused" }).mode).toBe(
      "paused",
    );
  });
});
