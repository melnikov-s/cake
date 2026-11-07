import { readFile } from "node:fs/promises";
import type { PresetContext } from "../../contracts/model-presets/preset-context";

export function resolvePresetContext(
  preset: PresetContext | undefined,
  configured?: readonly Pick<PresetContext, "id" | "promptFile">[],
): PresetContext | undefined {
  const current = preset && configured?.find((candidate) => candidate.id === preset.id);
  return current
    ? { id: current.id, ...(current.promptFile ? { promptFile: current.promptFile } : null) }
    : preset;
}

/** Runtime adapters reread guidance for each prompt, including externally edited files. */
export async function loadPresetContext(
  selected: PresetContext | undefined,
  configured?: readonly Pick<PresetContext, "id" | "promptFile">[],
): Promise<PresetContext | undefined> {
  const preset = resolvePresetContext(selected, configured);
  if (!preset?.promptFile) return preset;
  try {
    return { ...preset, prompt: await readFile(preset.promptFile, "utf8") };
  } catch (cause) {
    throw new Error(`Could not read preset prompt ${preset.promptFile}: ${String(cause)}`, {
      cause,
    });
  }
}
