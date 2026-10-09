import { describe, expect, it } from "vitest";
import { PunctuationEngine } from "../../../src/services/dictation/local-punctuation";
import { punctuationPreview } from "../../../src/utils/punctuation-text";

const signal = () => new AbortController().signal;
const engine = () =>
  new PunctuationEngine(async (ids) => ({
    after: ids.map((_, index) => (index === ids.length - 2 ? 4 : 0)),
    capitalize: ids.map((id, index) => index === 1 || id === 19),
  }));

describe("local punctuation source projection", () => {
  it("withholds a guessed question ending and revises the same passage across audio boundaries", async () => {
    const local = engine();
    const partial = await local.punctuate(
      "Is this a question that I should?",
      false,
      signal(),
      "insertion",
    );
    expect(partial.text).toBe("Is this a question that I should");
    expect(partial.pendingStart).toBeLessThan(partial.text.length);
    const continued = await local.punctuate(
      "Is this a question that I should? Be asking?",
      false,
      signal(),
      "insertion",
    );
    expect(continued.text).toBe("Is this a question that I should be asking");
    const finished = await local.punctuate(
      "Is this a question that I should? Be asking?",
      true,
      signal(),
      "insertion",
    );
    expect(finished.text).toBe("Is this a question that I should be asking?");
    expect(finished.pendingStart).toBe(finished.text.length);
  });

  it("never reconstructs unknown characters, code, identifiers, paths, URLs or decimals", async () => {
    const local = new PunctuationEngine(async (ids) => ({
      after: ids.map(() => 2),
      capitalize: ids.map(() => true),
    }));
    const protectedText =
      "src/main.ts postProcessEnabled https://example.com/a?b=1 1.5 $12.50 `/tmp/a-b` ```\nconst value = 0.003;\n``` 👋";
    const result = await local.punctuate(protectedText, true, signal(), "technical");
    expect(result.text).toBe(protectedText);
    expect(result.text).not.toContain("<Unk>");
    expect(punctuationPreview(protectedText)).toBe(protectedText);
  });

  it("retains fillers and negations rather than behaving as a rewriting model", async () => {
    const result = await engine().punctuate(
      "Um, do not delete the files. Uh, only the temporary folder.",
      true,
      signal(),
      "fillers",
    );
    expect(result.text).toBe("Um do not delete the files uh only the temporary folder?");
  });

  it("uses bounded overlapping windows without losing words from a long passage", async () => {
    const lengths: number[] = [];
    const local = new PunctuationEngine(async (ids) => {
      lengths.push(ids.length);
      return { after: ids.map(() => 0), capitalize: ids.map(() => false) };
    });
    const text = Array.from({ length: 700 }, () => "streaming words").join(" ");
    const result = await local.punctuate(text, true, signal(), "long-insertion");
    expect(result.text).toBe(text);
    expect(lengths.length).toBeGreaterThan(1);
    expect(Math.max(...lengths)).toBeLessThanOrEqual(256);
    lengths.length = 0;
    const continued = text + " continue here";
    expect((await local.punctuate(continued, false, signal(), "long-insertion")).text).toBe(
      continued,
    );
    expect(lengths.length).toBeLessThanOrEqual(2);
    lengths.length = 0;
    await local.punctuate(continued, false, signal(), "fresh-insertion");
    expect(lengths.length).toBeGreaterThan(2);
    lengths.length = 0;
    const corrected = continued.replace(/^streaming/, "corrected");
    expect((await local.punctuate(corrected, true, signal(), "fresh-insertion")).text).toBe(
      corrected,
    );
    expect(lengths.length).toBeGreaterThan(2);
  });

  it("does not capitalize the artificial start of a rolling mid-sentence window", async () => {
    const local = new PunctuationEngine(async (ids) => ({
      after: ids.map(() => 0),
      capitalize: ids.map((_, index) => index === 1),
    }));
    const original = Array.from({ length: 240 }, () => "streaming").join(" ");
    await local.punctuate(original, false, signal(), "rolling");
    const continued = original + " more words";
    expect((await local.punctuate(continued, false, signal(), "rolling")).text).toBe(
      "S" + continued.slice(1),
    );
  });

  it("drops an inference completion after cancellation", async () => {
    const controller = new AbortController();
    const local = new PunctuationEngine(async (ids) => {
      controller.abort();
      return { after: ids.map(() => 0), capitalize: ids.map(() => false) };
    });
    await expect(
      local.punctuate("Do not apply this result", false, controller.signal, "cancelled"),
    ).rejects.toThrow();
  });
});
