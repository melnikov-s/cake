import { describe, expect, it } from "vitest";
import { searchSessions } from "../../../src/renderer/lib/session-search";

const session = (sessionId: string, title: string, day = 1) => ({
  sessionId,
  title,
  modifiedAt: `2026-01-${String(day).padStart(2, "0")}T00:00:00Z`,
});
const ids = (query: string, sessions: ReturnType<typeof session>[]) =>
  searchSessions(sessions, query).map((item) => item.sessionId);

describe("deterministic session title ranking", () => {
  it("ranks exact, prefix, phrase, reordered lexical tokens, then fuzzy abbreviations", () => {
    expect(
      ids("search dialog", [
        session("fuzzy", "SearXch dialXog", 6),
        session("tokens", "Dialog for session search", 5),
        session("phrase", "Build search dialog", 4),
        session("prefix", "Search dialog keyboard", 3),
        session("exact", "Search dialog", 1),
      ]),
    ).toEqual(["exact", "prefix", "phrase", "tokens", "fuzzy"]);
    expect(ids("srch dlg", [session("match", "Search dialog"), session("no", "Settings")])).toEqual(
      ["match"],
    );
  });

  it("normalizes case, accents and whitespace and treats punctuation literally", () => {
    expect(ids("  CAFE   SEARCH ", [session("match", "Café Search")])).toEqual(["match"]);
    expect(ids("c++", [session("cpp", "C++ settings"), session("c", "C settings")])).toEqual([
      "cpp",
    ]);
    expect(ids("[", [session("bracket", "Fix [parser]"), session("no", "Parser")])).toEqual([
      "bracket",
    ]);
  });

  it("uses recency then stable identity for empty queries and tied matches without mutating input", () => {
    const input = [session("b", "Title", 2), session("a", "Title", 2), session("old", "Title", 1)];
    expect(ids("", input)).toEqual(["a", "b", "old"]);
    expect(ids("title", input)).toEqual(["a", "b", "old"]);
    expect(input.map((item) => item.sessionId)).toEqual(["b", "a", "old"]);
  });

  it("requires every token and rejects distant fuzzy noise and single-letter fuzzy matches", () => {
    expect(ids("search missing", [session("no", "Session search")])).toEqual([]);
    expect(ids("abc", [session("no", "a" + "x".repeat(30) + "bc")])).toEqual([]);
    expect(ids("z", [session("no", "Session search")])).toEqual([]);
  });
});
