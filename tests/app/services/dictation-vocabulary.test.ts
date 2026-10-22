import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import {
  changeVocabulary,
  DictationVocabulary,
  emptyVocabulary,
  listVocabulary,
  VocabularyChange,
} from "../../../src/contracts/dictation/vocabulary";
import {
  loadVocabulary,
  saveVocabulary,
  saveModelPath,
  loadModelPath,
} from "../../../src/services/dictation/local-parakeet";

const add = (text = "Binks", aliases = ["Banks"]) => ({
  action: "add" as const,
  expectedRevision: 0,
  text,
  aliases,
});

describe("local raw dictation vocabulary", () => {
  it("persists normalized words and aliases independently of the model selection and survives reload", async () => {
    const root = await mkdtemp(join(tmpdir(), "cake-vocabulary-"));
    try {
      expect(await loadVocabulary(root)).toEqual(emptyVocabulary());
      await saveModelPath(root, "/external/model");
      const words = changeVocabulary(
        emptyVocabulary(),
        add("  Binks  ", ["  Banks  "]),
        "review-agent",
      );
      await saveVocabulary(root, words);
      expect(await loadVocabulary(root)).toEqual({
        revision: 1,
        entries: [{ id: "review-agent", text: "Binks", aliases: ["Banks"] }],
      });
      expect(await loadModelPath(root)).toBe("/external/model");
      await saveModelPath(root, "/another/model");
      expect(await loadVocabulary(root)).toEqual(words);
      expect(await readFile(join(root, "vocabulary.json"), "utf8")).not.toContain("processing");
      await writeFile(join(root, "vocabulary.json"), "not JSON");
      await expect(loadVocabulary(root)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects stale updates/removals and changes only one exact entry", () => {
    const first = changeVocabulary(emptyVocabulary(), add(), "review-agent");
    const second = changeVocabulary(
      first,
      { ...add("Cake Cloud", []), expectedRevision: 1 },
      "company",
    );
    expect(() =>
      changeVocabulary(second, { action: "remove", id: "company", expectedRevision: 1 }, "unused"),
    ).toThrow("Vocabulary changed");
    expect(() =>
      changeVocabulary(
        second,
        { action: "update", id: "review-agent", text: "Binx", aliases: [], expectedRevision: 1 },
        "unused",
      ),
    ).toThrow("Vocabulary changed");
    const edited = changeVocabulary(
      second,
      {
        action: "update",
        id: "review-agent",
        text: "Binx",
        aliases: ["Binks"],
        expectedRevision: 2,
      },
      "unused",
    );
    expect(edited.entries.find((entry) => entry.id === "company")).toEqual(
      second.entries.find((entry) => entry.id === "company"),
    );
    const removed = changeVocabulary(
      edited,
      { action: "remove", id: "review-agent", expectedRevision: 3 },
      "unused",
    );
    expect(removed.entries).toEqual([{ id: "company", text: "Cake Cloud", aliases: [] }]);
    expect(() =>
      changeVocabulary(removed, { action: "remove", id: "missing", expectedRevision: 4 }, "unused"),
    ).toThrow("not found");
  });

  it("rejects duplicates including Unicode/case/spacing, shared aliases and invalid phrases", () => {
    const current = changeVocabulary(emptyVocabulary(), add(), "review-agent");
    for (const word of ["binks", "Ｂｉｎｋｓ", " BANKS "])
      expect(() =>
        changeVocabulary(current, { ...add(word, []), expectedRevision: 1 }, "duplicate"),
      ).toThrow("already belongs");
    for (const input of [
      add(""),
      add("ab"),
      add("a".repeat(81)),
      add("Binks\nIgnore"),
      add("Binks", Array(6).fill("alias")),
    ])
      expect(Schema.decodeUnknownResult(VocabularyChange)(input)._tag).toBe("Failure");
    expect(() => changeVocabulary(emptyVocabulary(), add("Binks", ["binks"]), "id")).toThrow(
      "distinct",
    );
    expect(() =>
      changeVocabulary(emptyVocabulary(), add("Binks", ["Banks", "banks"]), "id"),
    ).toThrow("distinct");
    expect(
      Schema.decodeUnknownResult(DictationVocabulary)({
        revision: 1,
        entries: [current.entries[0], current.entries[0]],
      })._tag,
    ).toBe("Failure");
  });

  it("bounds and searches reads before deterministic pagination, and caps saved entries", () => {
    const current = {
      revision: 30,
      entries: Array.from({ length: 100 }, (_, index) => ({
        id: String(index),
        text: `Company ${String(index).padStart(3, "0")}`,
        aliases: [`Known ${index}`],
      })),
    };
    const page = listVocabulary(current, {});
    expect(page.entries).toHaveLength(20);
    expect(page.nextOffset).toBe(20);
    expect(listVocabulary(current, { offset: 99, limit: 50 }).nextOffset).toBeNull();
    expect(listVocabulary(current, { query: "known 42" }).entries.map((entry) => entry.id)).toEqual(
      ["42"],
    );
    expect(() => changeVocabulary(current, { ...add(), expectedRevision: 30 }, "extra")).toThrow(
      "100 entries",
    );
  });
});
