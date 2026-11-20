import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Runtime startup requires a saved Session model or a Cake default preset (81eb383b); without
 * one, a new Session shows "Choose a model to continue" and never starts its runtime, so
 * extensions, the session_start hook and commands never run.
 */
export interface FixtureModelOptions {
  /** OpenAI-compatible base URL, for example `http://127.0.0.1:1/v1` when never prompted. */
  readonly baseUrl: string;
  readonly provider?: string;
  readonly modelId?: string;
  readonly name?: string;
}

export const fixtureModelPresetId = "00000000-0000-4000-8000-0000000000f1";

/** Writes Pi's models.json with one local OpenAI-compatible model. */
export async function writeFixtureModels(cakeHome: string, options: FixtureModelOptions) {
  const provider = options.provider ?? "fixture";
  const modelId = options.modelId ?? "fixture-model";
  await mkdir(join(cakeHome, "pi"), { recursive: true });
  await writeFile(
    join(cakeHome, "pi", "models.json"),
    JSON.stringify({
      providers: {
        [provider]: {
          baseUrl: options.baseUrl,
          apiKey: "fixture",
          api: "openai-completions",
          models: [
            {
              id: modelId,
              name: options.name ?? "Fixture model",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 128_000,
              maxTokens: 1_024,
            },
          ],
        },
      },
    }),
  );
  return { provider, modelId };
}

/** Application-state fields that make the fixture model the Cake default preset. */
export function fixtureDefaultPreset(options: Omit<FixtureModelOptions, "baseUrl"> = {}) {
  return {
    modelPresets: [
      {
        id: fixtureModelPresetId,
        name: options.name ?? "Fixture model",
        provider: options.provider ?? "fixture",
        modelId: options.modelId ?? "fixture-model",
        thinkingLevel: "off",
        fastMode: false,
      },
    ],
    defaultModelPresetId: fixtureModelPresetId,
  } as const;
}

/** Session JSONL entry that saves the fixture model on a seeded Session. */
export function fixtureModelChange(
  timestamp: string,
  options: Omit<FixtureModelOptions, "baseUrl"> & { readonly id?: string } = {},
) {
  return {
    type: "model_change",
    id: options.id ?? "model",
    parentId: null,
    timestamp,
    provider: options.provider ?? "fixture",
    modelId: options.modelId ?? "fixture-model",
  } as const;
}
