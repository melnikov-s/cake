import assert from "node:assert/strict";
import { Schema } from "effect";
import { describe, it } from "vitest";
import {
  CakeModelSelection,
  resolveCakeModelSelection,
  type CakeModelPresetCatalog,
} from "../../../src/domain/cake-model-selection";

const catalog: CakeModelPresetCatalog = {
  presets: [
    {
      id: "00000000-0000-4000-8000-000000000001",
      name: "Sol",
      provider: "openai-codex",
      modelId: "gpt-5.6-sol",
      thinkingLevel: "high",
      fastMode: false,
    },
    {
      id: "00000000-0000-4000-8000-000000000002",
      name: "Sol-Fast",
      provider: "openai-codex",
      modelId: "gpt-5.6-sol",
      thinkingLevel: "high",
      fastMode: true,
    },
  ],
  defaultPresetId: "00000000-0000-4000-8000-000000000001",
};

describe("Cake model selection", () => {
  it("resolves preset names by their full configuration rather than model ID", () => {
    assert.deepEqual(resolveCakeModelSelection("Sol", catalog), {
      provider: "openai-codex",
      modelId: "gpt-5.6-sol",
      thinkingLevel: "high",
      fastMode: false,
    });
    assert.deepEqual(resolveCakeModelSelection("Sol-Fast", catalog), {
      provider: "openai-codex",
      modelId: "gpt-5.6-sol",
      thinkingLevel: "high",
      fastMode: true,
    });
  });

  it("resolves the current preset snapshot rather than creating a live binding", () => {
    const mutableCatalog = {
      ...catalog,
      presets: catalog.presets.map((preset) => ({ ...preset })),
    };
    const first = resolveCakeModelSelection("Sol", mutableCatalog);
    mutableCatalog.presets[0]!.thinkingLevel = "low";
    mutableCatalog.presets[0]!.fastMode = true;
    const second = resolveCakeModelSelection("Sol", mutableCatalog);
    assert.equal(first.thinkingLevel, "high");
    assert.equal(first.fastMode, false);
    assert.equal(second.thinkingLevel, "low");
    assert.equal(second.fastMode, true);
  });

  it("accepts explicit configurations and defaults only their optional Fast mode", () => {
    const decoded = Schema.decodeUnknownSync(CakeModelSelection)({
      provider: "openai-codex",
      modelId: "gpt-5.6-sol",
      thinkingLevel: "xhigh",
    });
    assert.deepEqual(resolveCakeModelSelection(decoded, catalog), {
      provider: "openai-codex",
      modelId: "gpt-5.6-sol",
      thinkingLevel: "xhigh",
      fastMode: false,
    });
    assert.throws(() =>
      Schema.decodeUnknownSync(CakeModelSelection)({
        provider: "openai-codex",
        modelId: "gpt-5.6-sol",
      }),
    );
  });

  it("fails unknown preset names without treating strings as raw model IDs", () => {
    assert.throws(
      () => resolveCakeModelSelection("gpt-5.6-sol", catalog),
      /Unknown model preset "gpt-5\.6-sol"\. Call models\.list/,
    );
  });

  it("snapshots the inherited configuration when selection is omitted", () => {
    const inherited = {
      provider: "anthropic",
      modelId: "claude-opus",
      thinkingLevel: "max" as const,
      fastMode: true,
    };
    const resolved = resolveCakeModelSelection(undefined, catalog, inherited);
    assert.deepEqual(resolved, inherited);
    assert.notEqual(resolved, inherited);
    assert.throws(
      () => resolveCakeModelSelection(undefined, catalog),
      /there is no model to inherit/,
    );
  });
});
