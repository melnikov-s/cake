import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  ModelPresetCreateInput,
  ModelPresetProjection,
  ModelPresetUpdateInput,
} from "../../../src/domain/modelPresets";
import { CakeIpcClient } from "../../../src/ipc/client/CakeIpcClient";
import { ModelSelection } from "../../../src/services/pi/model-data";
import { makeRendererRuntime } from "../../../src/renderer/RendererRuntime";

const preset = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "Deep review",
  provider: "openai-codex",
  modelId: "gpt-5.6-sol",
  thinkingLevel: "high" as const,
  fastMode: true,
};

describe("Model Preset Effect RPC contract", () => {
  it("decodes every command input and authoritative result schema", () => {
    expect(
      Schema.decodeUnknownSync(ModelPresetCreateInput)({
        name: preset.name,
        provider: preset.provider,
        modelId: preset.modelId,
        thinkingLevel: preset.thinkingLevel,
        fastMode: preset.fastMode,
      }),
    ).toMatchObject({ name: preset.name });
    expect(Schema.decodeUnknownSync(ModelPresetUpdateInput)(preset)).toEqual(preset);
    expect(
      Schema.decodeUnknownSync(ModelPresetProjection)({
        presets: [preset],
        defaultPresetId: preset.id,
      }),
    ).toEqual({ presets: [preset], defaultPresetId: preset.id });
    expect(
      Schema.decodeUnknownSync(ModelSelection)({
        provider: preset.provider,
        modelId: preset.modelId,
        thinkingLevel: preset.thinkingLevel,
        fastMode: preset.fastMode,
      }),
    ).toMatchObject({ modelId: preset.modelId });
  });

  it("rejects malformed command payloads", () => {
    expect(() =>
      Schema.decodeUnknownSync(ModelPresetCreateInput)({
        name: "",
        provider: "",
        modelId: "",
        thinkingLevel: "reasoning",
        fastMode: "yes",
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(ModelPresetUpdateInput)({ ...preset, id: "renderer-id" }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(ModelPresetProjection)({
        presets: Array.from({ length: 101 }, () => preset),
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(ModelPresetProjection)({
        presets: [preset, preset],
        defaultPresetId: preset.id,
      }),
    ).toThrow();
  });

  it("exposes generated Effect clients grouped by models and modelPresets", async () => {
    const runtime = makeRendererRuntime({
      send() {},
      subscribe() {
        return () => {};
      },
    });
    const client = await runtime.execute(Effect.service(CakeIpcClient));
    expect(Object.keys(client.models)).toEqual(["list", "refresh"]);
    expect(Object.keys(client.modelPresets)).toEqual([
      "list",
      "create",
      "update",
      "remove",
      "setDefault",
      "resolve",
    ]);
    await runtime.dispose();
  });
});
