import assert from "node:assert/strict";
import { Schema } from "effect";
import { describe, it } from "vitest";
import {
  CakeModelSelection,
  type CakeModelPresetCatalog,
  type ExplicitCakeModelSelection,
  type CakeModelChoice,
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

const preset = (index: number) => ({ id: catalog.presets[index]!.id });
describe("Cake model selection", () => {
  it("keeps different prompts on presets of the exact same model configuration", () => {
    const first = { ...catalog.presets[0]!, prompt: "Be concise." };
    const second = {
      ...first,
      id: catalog.presets[1]!.id,
      name: "Detailed",
      prompt: "Explain deeply.",
    };
    const choices = { presets: [first, second] };
    assert.deepEqual(resolveCakeModelSelection(first.name, choices).preset, {
      id: first.id,
      prompt: first.prompt,
    });
    assert.deepEqual(resolveCakeModelSelection(second.name, choices).preset, {
      id: second.id,
      prompt: second.prompt,
    });
    const raw = {
      provider: first.provider,
      modelId: first.modelId,
      thinkingLevel: first.thinkingLevel,
      fastMode: first.fastMode,
    };
    assert.equal(resolveCakeModelSelection(raw, choices).preset, undefined);
  });
  it("resolves preset names by their full configuration rather than model ID", () => {
    assert.deepEqual(resolveCakeModelSelection("Sol", catalog), {
      preset: preset(0),
      provider: "openai-codex",
      modelId: "gpt-5.6-sol",
      thinkingLevel: "high",
      fastMode: false,
    });
    assert.deepEqual(resolveCakeModelSelection("Sol-Fast", catalog), {
      preset: preset(1),
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
      preset: preset(1),
      provider: "openai-codex",
      modelId: "gpt-5.6-sol",
      thinkingLevel: "high",
      fastMode: true,
    });
    // Changing the configured default is respected at the next resolution.
    assert.deepEqual(resolveCakeModelSelection(undefined, catalog, caller), {
      preset: preset(0),
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

  describe("omitted subagent model follows the Subagent default model setting", () => {
    const caller = {
      provider: "anthropic",
      modelId: "claude-opus",
      thinkingLevel: "max" as const,
      fastMode: true,
    };
    const utilityModel = { provider: "openai", modelId: "gpt-mini", thinkingLevel: "low" as const };
    const freeform = {
      provider: "custom",
      modelId: "not-a-preset",
      thinkingLevel: "minimal" as const,
      fastMode: true,
    };
    const withDefault = { ...catalog, defaultPresetId: catalog.presets[1]!.id, utilityModel };
    const sol = {
      provider: "openai-codex",
      modelId: "gpt-5.6-sol",
      thinkingLevel: "high" as const,
    };
    const cases: Array<[string, CakeModelChoice | undefined, ExplicitCakeModelSelection]> = [
      ["unset → caller (Inherit is the default)", undefined, caller],
      [
        "default → default preset",
        { source: "default" },
        { ...sol, fastMode: true, preset: preset(1) },
      ],
      ["inherit → caller", { source: "inherit" }, caller],
      ["utility → utility model", { source: "utility" }, { ...utilityModel, fastMode: false }],
      [
        "preset → that preset",
        { source: "preset", presetId: catalog.presets[0]!.id },
        { ...sol, fastMode: false, preset: preset(0) },
      ],
      ["model → that model", { source: "model", model: freeform }, freeform],
    ];
    for (const [name, subagentDefaultModel, expected] of cases)
      it(name, () => {
        const configured = { ...withDefault, subagentDefaultModel };
        const resolved = resolveCakeModelSelection(undefined, configured, caller, "subagent");
        assert.deepEqual(resolved, expected);
        assert.notEqual(resolved, caller);
        // Session launches ignore the subagent setting.
        assert.deepEqual(resolveCakeModelSelection(undefined, configured, caller), {
          preset: preset(1),
          ...sol,
          fastMode: true,
        });
        // An explicit selection overrides the setting exactly.
        assert.equal(
          resolveCakeModelSelection("Sol", configured, caller, "subagent").fastMode,
          false,
        );
        assert.deepEqual(
          resolveCakeModelSelection(freeform, configured, caller, "subagent"),
          freeform,
        );
      });

    it("falls back between Inherit and Default but never substitutes a missing choice", () => {
      const inherit = { ...withDefault, subagentDefaultModel: { source: "inherit" as const } };
      assert.deepEqual(resolveCakeModelSelection(undefined, inherit, undefined, "subagent"), {
        preset: preset(1),
        ...sol,
        fastMode: true,
      });
      assert.throws(
        () =>
          resolveCakeModelSelection(
            undefined,
            { presets: catalog.presets, subagentDefaultModel: { source: "inherit" } },
            undefined,
            "subagent",
          ),
        /no default model preset is configured/,
      );
      assert.throws(
        () =>
          resolveCakeModelSelection(
            undefined,
            { ...catalog, subagentDefaultModel: { source: "utility" } },
            caller,
            "subagent",
          ),
        /no utility model is configured/,
      );
      assert.throws(
        () =>
          resolveCakeModelSelection(
            undefined,
            {
              ...catalog,
              subagentDefaultModel: {
                source: "preset",
                presetId: "00000000-0000-4000-8000-0000000000ff",
              },
            },
            caller,
            "subagent",
          ),
        /preset no longer exists/,
      );
    });
  });
});
