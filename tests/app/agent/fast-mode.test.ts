import { describe, expect, it } from "vitest";
import {
  CODEX_FAST_MODE_SERVICE_TIER,
  applyFastModePayload,
  supportsFastMode,
} from "../../../src/services/pi/fast-mode";

describe("Codex Fast mode", () => {
  it("matches the current Codex model-level capability", () => {
    expect(supportsFastMode({ provider: "openai-codex", id: "gpt-5.6-luna" })).toBe(true);
    expect(supportsFastMode({ provider: "openai-codex", id: "gpt-5.4-mini" })).toBe(false);
    expect(supportsFastMode({ provider: "openai", id: "gpt-5.6-luna" })).toBe(false);
  });

  it("adds Codex priority processing only when enabled for a supported model", () => {
    const payload = { model: "gpt-5.6-luna", stream: true };
    expect(
      applyFastModePayload(payload, { provider: "openai-codex", id: "gpt-5.6-luna" }, true),
    ).toEqual({ ...payload, service_tier: CODEX_FAST_MODE_SERVICE_TIER });
    expect(
      applyFastModePayload(payload, { provider: "openai-codex", id: "gpt-5.6-luna" }, false),
    ).toBe(payload);
    expect(
      applyFastModePayload(payload, { provider: "openai-codex", id: "gpt-5.4-mini" }, true),
    ).toBe(payload);
  });
});
