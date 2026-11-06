import { describe, expect, it } from "vitest";
import { matchesDiscardFilter } from "../../../src/contracts/dictation/discard-filters";

const sensitive = [{ text: "Yeah.", matchCase: true }];
describe("whole-utterance discard normalization", () => {
  it.each(["Yeah.", "Yeah", "  Yeah.\n", "“Yeah!”"])(
    "matches edge-normalized %j without altering stored case",
    (text) => {
      expect(matchesDiscardFilter(text, sensitive)).toBe(true);
      expect(sensitive).toEqual([{ text: "Yeah.", matchCase: true }]);
    },
  );
  it.each(["yeah", "yeah.", "YEAH!", "Yeah, carry on.", "I said Yeah.", "Yeah. Yeah.", "", "..."])(
    "retains nonmatching %j",
    (text) => {
      expect(matchesDiscardFilter(text, sensitive)).toBe(false);
    },
  );
  it("ignores case only when requested, preserving internal whitespace and punctuation", () => {
    const filters = [{ text: "No thanks.", matchCase: false }];
    expect(matchesDiscardFilter("NO THANKS!", filters)).toBe(true);
    expect(matchesDiscardFilter("No  thanks", filters)).toBe(false);
    expect(matchesDiscardFilter("No, thanks", filters)).toBe(false);
    expect(matchesDiscardFilter("No thanks, please", filters)).toBe(false);
  });
});
