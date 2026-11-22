/** Identity for Antigravity’s default, not a concrete model ID. Keep the stored key for existing presets. */
export const antigravityModel = {
  provider: "antigravity",
  modelId: "gemini",
  name: "Antigravity default",
} as const;

export const isAntigravityModel = (selection?: { provider: string }) =>
  selection?.provider === antigravityModel.provider;

export const antigravityModelName = (modelId: string) =>
  modelId === antigravityModel.modelId ? antigravityModel.name : modelId;

export const antigravityDesktopOnly =
  "Antigravity requires an interactive desktop conversation. Choose another model for background work.";

export const antigravityPromptError = (text: string) =>
  !text.trim() || text.length > 32_768 || /^[!/]/.test(text.trimStart())
    ? "Antigravity accepts plain messages of up to 32,768 characters, not Cake commands"
    : undefined;

export const antigravitySettingsError =
  "Choose an advertised Antigravity variant to set the model and effort. Cake thinking levels, Fast mode, and preset prompts are not supported.";

export function supportsAntigravitySettings(selection: {
  thinkingLevel: string;
  fastMode: boolean;
  promptFile?: string;
  prompt?: string;
  preset?: { promptFile?: string };
}) {
  return (
    selection.thinkingLevel === "off" &&
    !selection.fastMode &&
    selection.promptFile === undefined &&
    selection.prompt === undefined &&
    selection.preset?.promptFile === undefined
  );
}
