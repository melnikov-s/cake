import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadPunctuationEngine } from "../../src/services/dictation/local-punctuation";

// Opt-in external CPU-runtime/model verification. No downloads or provider calls from tests.
const root = process.env.CAKE_PUNCTUATION_TEST_ROOT;
describe.skipIf(!root)("real local English punctuation model", () => {
  let loaded: Awaited<ReturnType<typeof loadPunctuationEngine>>;
  beforeAll(async () => {
    loaded = await loadPunctuationEngine(root!);
  });
  afterAll(async () => {
    await loaded?.close();
  });

  it("reconsiders a hesitant question across segments and suppresses tentative terminal punctuation", async () => {
    const signal = new AbortController().signal;
    const partial = await loaded.engine.punctuate(
      "Is this a question that I should?",
      false,
      signal,
      "question",
    );
    expect(partial.text).toBe("Is this a question that I should");
    const continuation = "Is this a question that I should? Be asking?";
    expect((await loaded.engine.punctuate(continuation, false, signal, "question")).text).toBe(
      "Is this a question that I should be asking",
    );
    expect((await loaded.engine.punctuate(continuation, true, signal, "question")).text).toBe(
      "Is this a question that I should be asking?",
    );
    expect(
      (
        await loaded.engine.punctuate(
          continuation + " Yeah, I think it is.",
          true,
          signal,
          "question",
        )
      ).text,
    ).toBe("Is this a question that I should be asking? Yeah, I think it is.");
  });

  it("preserves technical source characters and does not remove filler words", async () => {
    const text =
      "Um, use src/main.ts and postProcessEnabled. Keep https://example.com/a?b=1 and version 1.5. Cost $12.50. Do not change `foo_bar()`.";
    const result = await loaded.engine.punctuate(
      text,
      true,
      new AbortController().signal,
      "technical",
    );
    for (const preserved of [
      "Um",
      "src/main.ts",
      "postProcessEnabled",
      "https://example.com/a?b=1",
      "1.5",
      "$12.50",
      "not",
      "`foo_bar()`",
    ])
      expect(result.text).toContain(preserved);
    expect(result.text).not.toMatch(/<unk>/i);
  });
});
