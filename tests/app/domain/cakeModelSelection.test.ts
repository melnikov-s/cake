import assert from "node:assert/strict";
import { Schema } from "effect";
import { describe, it } from "vitest";
import {
  CakeModelSelection,
  type CakeModelPresetCatalog,
} from "../../../src/contracts/model-presets/cake-model-selection";
import { resolveCakeModelSelection } from "../../../src/domain/model-presets/cake-model-selection";

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

  it("resolves an omitted selection to the default preset's complete settings, not the caller's", () => {
    const caller = {
      provider: "anthropic",
      modelId: "claude-opus",
      thinkingLevel: "max" as const,
      fastMode: false,
    };
    const fastDefault = { ...catalog, defaultPresetId: catalog.presets[1]!.id };
    assert.deepEqual(resolveCakeModelSelection(undefined, fastDefault, caller), {
      provider: "openai-codex",
      modelId: "gpt-5.6-sol",
      thinkingLevel: "high",
      fastMode: true,
    });
    // Changing the configured default is respected at the next resolution.
    assert.deepEqual(resolveCakeModelSelection(undefined, catalog, caller), {
      provider: "openai-codex",
      modelId: "gpt-5.6-sol",
      thinkingLevel: "high",
      fastMode: false,
    });
  });

  it("uses the caller's settings only when no default preset is configured", () => {
    const caller = {
      provider: "anthropic",
      modelId: "claude-opus",
      thinkingLevel: "max" as const,
      fastMode: true,
    };
    const withoutDefault = { presets: catalog.presets };
    const resolved = resolveCakeModelSelection(undefined, withoutDefault, caller);
    assert.deepEqual(resolved, caller);
    assert.notEqual(resolved, caller);
    assert.throws(
      () => resolveCakeModelSelection(undefined, withoutDefault),
      /no default model preset is configured/,
    );
  });
});
