import { Schema } from "effect";

/** Snapshot of the preset actually selected, never inferred from a model ID. */
export const PresetContext = Schema.Struct({
  id: Schema.String.check(Schema.isUUID(4)),
  prompt: Schema.optionalKey(Schema.String),
});
export interface PresetContext extends Schema.Schema.Type<typeof PresetContext> {}

export const presetGuidance = (preset: PresetContext | undefined): string | undefined =>
  preset?.prompt?.trim()
    ? `Preset guidance (supplements shared/project instructions; shared/project instructions take precedence):\n${preset.prompt}`
    : undefined;

/** Completion helpers may inherit a flattened parent prompt. Replace its preset section, not shared instructions. */
export function composePresetPrompt(
  instructions: string,
  preset: PresetContext | undefined,
): string {
  const guidance = presetGuidance(preset);
  const section = guidance ? `<model_preset>\n${guidance}\n</model_preset>` : "";
  const inherited = /^<model_preset>\n[\s\S]*?^<\/model_preset>(\n\n|$)/m;
  if (inherited.test(instructions))
    return instructions.replace(inherited, (_match, separator: string) =>
      section ? section + separator : "",
    );
  return section ? `${instructions}\n\n${section}` : instructions;
}
