import { Schema } from "effect";

export const CODEX_FAST_MODE_SERVICE_TIER = "priority" as const;
export const FastModePayload = Schema.Record(Schema.String, Schema.Unknown);
export type FastModePayload = typeof FastModePayload.Type;

/**
 * Codex's model catalog advertises Fast as a model-level service tier. Keep this
 * list aligned with the catalog instead of exposing the control for every model
 * behind the OpenAI Codex provider.
 */
const CODEX_FAST_MODE_MODEL_IDS = [
  "gpt-5.4",
  "gpt-5.5",
  "gpt-5.6-luna",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
] as const;

const codexFastModeModelIds = new Set<string>(CODEX_FAST_MODE_MODEL_IDS);

export interface FastModeModel {
  provider: string;
  id: string;
}

export function supportsFastMode(model: FastModeModel | undefined) {
  return model?.provider === "openai-codex" && codexFastModeModelIds.has(model.id);
}

export function applyFastModePayload(
  payload: FastModePayload,
  model: FastModeModel | undefined,
  enabled: boolean,
) {
  if (!enabled || !supportsFastMode(model)) return payload;
  return { ...payload, service_tier: CODEX_FAST_MODE_SERVICE_TIER };
}
