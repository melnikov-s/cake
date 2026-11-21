import type { Model } from "@earendil-works/pi-ai";
import {
  antigravityModel,
  antigravitySettingsError,
  supportsAntigravitySettings,
} from "../../../contracts/model-presets/antigravity-model";

/** Only for the session SDK's model state and transcript metadata. Never registered as a
 * provider: SDK completion, compaction and cache warming cannot make requests with it. */
export const antigravitySessionModel: Model<"cake-antigravity"> = {
  id: antigravityModel.modelId,
  provider: antigravityModel.provider,
  name: antigravityModel.name,
  api: "cake-antigravity",
  baseUrl: "",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 0,
  maxTokens: 0,
};

export function assertAntigravitySettings(
  selection: Parameters<typeof supportsAntigravitySettings>[0],
) {
  if (!supportsAntigravitySettings(selection)) throw new Error(antigravitySettingsError);
}
