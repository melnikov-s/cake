import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { Schema } from "effect";
import { ThinkingLevel } from "../../../contracts/pi/model-data";

const isThinkingLevel = Schema.is(ThinkingLevel);

/** The last recorded choice wins over a routed provider response. Older Pi
 * transcripts without a model change can still identify the last response model. */
export function savedSessionModel(branch: readonly SessionEntry[]):
  | {
      provider: string;
      modelId: string;
      thinkingLevel: ThinkingLevel;
    }
  | undefined {
  const chosen = branch.findLast((entry) => entry.type === "model_change");
  const response = chosen
    ? undefined
    : branch.findLast((entry) => entry.type === "message" && entry.message.role === "assistant");
  const model =
    chosen ??
    (response?.type === "message" && response.message.role === "assistant"
      ? { provider: response.message.provider, modelId: response.message.model }
      : undefined);
  if (!model) return undefined;
  const level = branch.findLast((entry) => entry.type === "thinking_level_change")?.thinkingLevel;
  return {
    provider: model.provider,
    modelId: model.modelId,
    thinkingLevel: isThinkingLevel(level) ? level : "off",
  };
}
