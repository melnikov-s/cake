import { describe, expect, it } from "vitest";
import {
  OPENAI_FAST_MODE_SERVICE_TIER,
  applyFastModePayload,
  supportsFastMode,
} from "../../../src/services/pi/fast-mode";

describe.each(["openai", "openai-codex"])("%s Fast mode", (provider) => {
  it.each([
    "gpt-5.4",
    "gpt-5.5",
    "gpt-5.6-luna",
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-6-astra",
    "gpt-6-luna",
    "gpt-6-sol",
    "gpt-6.1-sol",
  ])("exposes Fast for %s", (id) => {
    expect(supportsFastMode({ provider, id })).toBe(true);
  });

  it.each(["gpt-5.4-mini", "gpt-5.3-codex-spark", "gpt-6.2-sol"])(
    "does not infer Fast support for %s",
    (id) => {
      expect(supportsFastMode({ provider, id })).toBe(false);
    },
  );

  it.each(["gpt-6.1-sol", "gpt-6-astra"])(
    "requests Fast rather than Ultrafast for %s only when enabled",
    (id) => {
      const model = { provider, id };
      const payload = { model: id, stream: true, prompt_cache_key: "session" };
      expect(applyFastModePayload(payload, model, true)).toEqual({
        ...payload,
        service_tier: OPENAI_FAST_MODE_SERVICE_TIER,
      });
      expect(payload).not.toHaveProperty("service_tier");
      expect(applyFastModePayload(payload, model, false)).toBe(payload);
    },
  );

  it("leaves unsupported model requests unchanged", () => {
    const payload = { model: "gpt-5.4-mini", service_tier: "default" };
    expect(applyFastModePayload(payload, { provider, id: "gpt-5.4-mini" }, true)).toBe(payload);
  });
});

it("does not expose or apply OpenAI Fast mode for other providers or a missing model", () => {
  const payload = { model: "gpt-6.1-sol", stream: true };
  const model = { provider: "openrouter", id: "gpt-6.1-sol" };
  expect(supportsFastMode(model)).toBe(false);
  expect(supportsFastMode(undefined)).toBe(false);
  expect(applyFastModePayload(payload, model, true)).toBe(payload);
  expect(applyFastModePayload(payload, undefined, true)).toBe(payload);
});
