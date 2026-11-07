import { Effect, Layer } from "effect";
import { ModelPresetPrompts } from "../../../src/services/storage/ModelPresetPrompts";
import { ModelPresetValidationError } from "../../../src/contracts/model-presets/model-preset-data";

export const modelPresetPromptsTestLayer = Layer.sync(ModelPresetPrompts, () => {
  const files = new Map<string, string>();
  return ModelPresetPrompts.of({
    read: Effect.fn("ModelPresetPrompts.Test.read")(function* (file: string) {
      const prompt = files.get(file);
      if (prompt === undefined)
        return yield* new ModelPresetValidationError({ message: `Missing prompt file: ${file}` });
      return prompt;
    }),
    write: Effect.fn("ModelPresetPrompts.Test.write")((prompt, reference) =>
      Effect.sync(() => {
        const file = reference ?? `/cake/prompts/${crypto.randomUUID()}.md`;
        files.set(file, prompt);
        return file;
      }),
    ),
  });
});
