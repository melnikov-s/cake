import { Option, Schema } from "effect";

// OpenAI accepts "priority" and "fast" for the same Fast processing tier.
export const OPENAI_FAST_MODE_SERVICE_TIER = "priority" as const;
// Anthropic's Messages API requests Fast mode with `speed: "fast"` behind this beta.
// Without the beta, routing proxies may treat the request as ineligible for the
// first-party API and silently drop `speed`.
const ANTHROPIC_FAST_MODE_SPEED = "fast" as const;
export const ANTHROPIC_FAST_MODE_BETA = "fast-mode-2026-02-01" as const;
export const FastModePayload = Schema.Record(Schema.String, Schema.Unknown);
export type FastModePayload = typeof FastModePayload.Type;

/**
 * Pi does not project service-tier capabilities in its model catalog. Keep these
 * explicit lists aligned with each vendor's Fast-mode documentation; do not infer
 * support for every current or future model.
 * https://developers.openai.com/codex/speed/
 * https://developers.openai.com/api/docs/guides/fast-mode
 * https://docs.claude.com/en/docs/build-with-claude/fast-mode
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

// Verified against live responses: these report `usage.speed: "fast"`. Opus 4.6
// accepts `speed` but is served at standard speed, so it is not offered.
const ANTHROPIC_FAST_MODE_MODEL_IDS = [
  "claude-opus-4-8",
  "claude-opus-5",
  "claude-opus-5-5",
] as const;

/**
 * Fast mode is a first-party endpoint feature: gateways that reuse the same API
 * shape (Copilot, OpenCode, Cloudflare, Bedrock, Vertex) do not honor it. The
 * Shopify AI proxy registers the first-party ids plus window-size aliases that
 * route to the same first-party endpoints. Its `*-flex` providers request a
 * cheaper tier and are deliberately excluded.
 */
const OPENAI_FAST_MODE_PROVIDERS = new Set(["openai", "openai-codex", "openai-1m"]);
const ANTHROPIC_FAST_MODE_PROVIDERS = new Set([
  "anthropic",
  "anthropic-1m",
  "anthropic-250k-prefer-using-this-one",
]);

const openaiFastModeModelIds = new Set<string>(OPENAI_FAST_MODE_MODEL_IDS);
const anthropicFastModeModelIds = new Set<string>(ANTHROPIC_FAST_MODE_MODEL_IDS);

export interface FastModeModel {
  provider: string;
  id: string;
}

type FastModeProtocol = "openai-service-tier" | "anthropic-speed";

function fastModeProtocol(model: FastModeModel | undefined): FastModeProtocol | undefined {
  if (!model) return undefined;
  if (OPENAI_FAST_MODE_PROVIDERS.has(model.provider) && openaiFastModeModelIds.has(model.id))
    return "openai-service-tier";
  if (ANTHROPIC_FAST_MODE_PROVIDERS.has(model.provider) && anthropicFastModeModelIds.has(model.id))
    return "anthropic-speed";
  return undefined;
}

export function supportsFastMode(model: FastModeModel | undefined) {
  return fastModeProtocol(model) !== undefined;
}

const StringList = Schema.Array(Schema.String);

export function applyFastModePayload(
  payload: FastModePayload,
  model: FastModeModel | undefined,
  enabled: boolean,
): FastModePayload {
  if (!enabled) return payload;
  switch (fastModeProtocol(model)) {
    case "openai-service-tier":
      return { ...payload, service_tier: OPENAI_FAST_MODE_SERVICE_TIER };
    case "anthropic-speed": {
      // Pi's Anthropic adapter sends `betas` as the anthropic-beta header.
      const betas = Option.getOrElse(
        Schema.decodeUnknownOption(StringList)(payload.betas),
        (): ReadonlyArray<string> => [],
      );
      return {
        ...payload,
        speed: ANTHROPIC_FAST_MODE_SPEED,
        betas: betas.includes(ANTHROPIC_FAST_MODE_BETA)
          ? betas
          : [...betas, ANTHROPIC_FAST_MODE_BETA],
      };
    }
    case undefined:
      return payload;
  }
}

const AnthropicMessageStart = Schema.Struct({
  type: Schema.Literal("message_start"),
  message: Schema.Struct({
    usage: Schema.optionalKey(Schema.Struct({ speed: Schema.optionalKey(Schema.String) })),
  }),
});

const OpenAIResponseCompleted = Schema.Struct({
  type: Schema.Literal("response.completed"),
  response: Schema.Struct({ service_tier: Schema.optionalKey(Schema.NullOr(Schema.String)) }),
});

/** The raw provider stream events that report the speed actually served. */
export const FastModeResponseEvent = Schema.Union([AnthropicMessageStart, OpenAIResponseCompleted]);
export type FastModeResponseEvent = typeof FastModeResponseEvent.Type;
export const decodeFastModeResponseEvent = Schema.decodeUnknownOption(FastModeResponseEvent);

const OPENAI_FAST_SERVICE_TIERS = new Set(["priority", "fast"]);

/**
 * Reads the speed the provider actually served. Returns undefined when the event
 * does not report it for this model. Routing proxies fall back to standard-speed
 * capacity without an error, so this is the only reliable signal.
 */
export function servedFastModeSpeed(
  model: FastModeModel | undefined,
  event: FastModeResponseEvent,
): "fast" | "standard" | undefined {
  const protocol = fastModeProtocol(model);
  if (event.type === "message_start")
    return protocol === "anthropic-speed"
      ? event.message.usage?.speed === "fast"
        ? "fast"
        : "standard"
      : undefined;
  const tier = event.response.service_tier;
  // Some backends omit the tier; only an explicit non-fast tier is a fallback.
  if (protocol !== "openai-service-tier" || tier === undefined || tier === null) return undefined;
  return OPENAI_FAST_SERVICE_TIERS.has(tier) ? "fast" : "standard";
}

export type FastModeWarn = (message: string) => void;

/**
 * Observes one Fast-mode request's stream and warns once if the provider served
 * it at standard speed. Fast mode costs twice as much and counts toward premium
 * budgets, so a silent fallback should be visible in the logs.
 */
export function observeFastModeResponse(
  model: FastModeModel,
  warn: FastModeWarn = (message) => console.warn(message),
) {
  let settled = false;
  return (event: FastModeResponseEvent) => {
    if (settled) return;
    const speed = servedFastModeSpeed(model, event);
    if (speed === undefined) return;
    settled = true;
    if (speed === "standard")
      warn(
        `[Fast mode] ${model.provider}/${model.id} was requested in Fast mode but served at standard speed; the provider or proxy fell back silently.`,
      );
  };
}
