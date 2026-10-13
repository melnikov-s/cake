import { Schema } from "effect";

// OpenAI accepts "priority" and "fast" for the same Fast processing tier.
export const OPENAI_FAST_MODE_SERVICE_TIER = "priority" as const;
export const FastModePayload = Schema.Record(Schema.String, Schema.Unknown);
export type FastModePayload = typeof FastModePayload.Type;

/**
 * Pi does not project service-tier capabilities in its model catalog. Keep this
 * explicit list aligned with OpenAI's Fast-mode documentation and Codex catalog;
 * do not infer support for every current or future OpenAI model.
 * https://developers.openai.com/codex/speed/
 * https://developers.openai.com/api/docs/guides/fast-mode
 */
const OPENAI_FAST_MODE_MODEL_IDS = [
  "gpt-5.4",
  "gpt-5.5",
  "gpt-5.6-luna",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-6-astra",
  "gpt-6-luna",
  "gpt-6-sol",
  "gpt-6.1-sol",
] as const;

const openaiFastModeModelIds = new Set<string>(OPENAI_FAST_MODE_MODEL_IDS);

export interface FastModeModel {
  provider: string;
  id: string;
}

export function supportsFastMode(model: FastModeModel | undefined) {
  return (
    model !== undefined &&
    (model.provider === "openai" || model.provider === "openai-codex") &&
    openaiFastModeModelIds.has(model.id)
  );
}

export function applyFastModePayload(
  payload: FastModePayload,
  model: FastModeModel | undefined,
  enabled: boolean,
) {
  if (!enabled || !supportsFastMode(model)) return payload;
  return { ...payload, service_tier: OPENAI_FAST_MODE_SERVICE_TIER };
}
