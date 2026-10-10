import { describe, expect, it } from "vitest";
import { takeSpokenPhrases } from "../../../src/renderer/speech/spoken-text";
import { addPresentationModeReminder } from "../../../src/contracts/conversations/presentation-mode-reminders";

describe("spoken assistant prose", () => {
  it("emits complete sentence or bounded phrase units while holding unfinished prose until final", () => {
    const first = takeSpokenPhrases("Hello there. More", 0, false);
    expect(first.phrases).toEqual(["Hello there."]);
    expect(takeSpokenPhrases("Hello there. More", first.consumedCharacters, true).phrases).toEqual([
      "More",
    ]);
  });
  it("holds commas, semicolons and colons inside sentences and preserves contractions", () => {
    const first = takeSpokenPhrases("Well, this isn’t done; here’s why: more", 0, false);
    expect(first.phrases).toEqual([]);
    expect(first.consumedCharacters).toBe(0);
    const text = "Well, this isn’t done; here’s why: more context. Tail";
    const next = takeSpokenPhrases(text, first.consumedCharacters, false);
    expect(next.phrases).toEqual(["Well, this isn’t done; here’s why: more context."]);
    expect(takeSpokenPhrases(text, next.consumedCharacters, true).phrases).toEqual(["Tail"]);
    expect(takeSpokenPhrases("He said, ‘It isn't done.’ Next", 0, false).phrases).toEqual([
      "He said, ‘It isn't done.’",
    ]);
  });
  it("skips fenced code and tables even when their delimiters arrive across streamed updates", () => {
    const chunks = [
      "Intro. \n`",
      "``ts\nconst x = 1;\n",
      "```\n| A | B |\n| --- | --- |\n| 1 | 2 |\nDone.\n",
    ];
    let text = "",
      offset = 0;
    const heard: string[] = [];
    for (const chunk of chunks) {
      text += chunk;
      const result = takeSpokenPhrases(text, offset, false);
      heard.push(...result.phrases);
      offset = result.consumedCharacters;
    }
    expect(heard).toEqual(["Intro.", "Done."]);
  });
  it("keeps long outer fences open across shorter or language-bearing inner markers and resumes prose once", () => {
    for (const character of ["`", "~"]) {
      const chunks = [
        `Intro.\n${character.repeat(2)}`,
        `${character.repeat(2)}markdown\n`,
        `${character.repeat(3)}ts\nSecret code sentence.\n`,
        `${character.repeat(3)}\nMore secret code.\n`,
        `${character.repeat(4)}not-a-close\nStill secret.\n`,
        `${character.repeat(5)}  \nFollowing prose.\n`,
      ];
      let text = "",
        offset = 0;
      const heard: string[] = [];
      for (const chunk of chunks) {
        text += chunk;
        const result = takeSpokenPhrases(text, offset, false);
        expect(result.consumedCharacters).toBeGreaterThanOrEqual(offset);
        heard.push(...result.phrases);
        offset = result.consumedCharacters;
      }
      expect(heard).toEqual(["Intro.", "Following prose."]);
      const settled = takeSpokenPhrases(text, offset, true);
      expect(settled.phrases).toEqual([]);
      expect(settled.consumedCharacters).toBe(text.length);
      expect(takeSpokenPhrases(text, settled.consumedCharacters, true).phrases).toEqual([]);
    }
  });
  it("removes presentation markup and speaks link labels rather than raw URLs", () => {
    const raw = addPresentationModeReminder(
      "**Read** [the guide](https://example.com) now.\n",
      "normal",
      "draw",
    );
    expect(takeSpokenPhrases(raw, 0, true).phrases.join(" ")).toBe("Read the guide now.");
  });
  it("uses absolute raw offsets so skipped code, appended text and final flush neither repeat nor lose prose", () => {
    let raw = "One.\n```js\nconst a = 1;\n```\nTail";
    const first = takeSpokenPhrases(raw, 0, false);
    expect(first.phrases).toEqual(["One."]);
    raw += " end";
    const last = takeSpokenPhrases(raw, first.consumedCharacters, true);
    expect(last.phrases).toEqual(["Tail end"]);
    expect(last.consumedCharacters).toBe(raw.length);
    expect(takeSpokenPhrases(raw, last.consumedCharacters, true).phrases).toEqual([]);
  });
  it("bounds every synthesis phrase to 2000 characters without truncating the visible answer", () => {
    const text = "word ".repeat(1300);
    const result = takeSpokenPhrases(text, 0, true);
    expect(result.phrases.every((phrase) => phrase.length <= 2000)).toBe(true);
    expect(result.phrases.join(" ")).toBe(text.trim());
    expect(result.consumedCharacters).toBe(text.length);
  });
});
