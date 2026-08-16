import { describe, expect, it } from "vitest";
import { pluginBackendHostMessageSchema } from "../../../src/plugin/backend-protocol";

describe("plugin backend protocol", () => {
  it("parses both successful and failed result messages", () => {
    expect(pluginBackendHostMessageSchema.parse({
      type: "result",
      callId: "00000000-0000-4000-8000-000000000000",
      ok: true,
      value: { branch: "main" }
    })).toMatchObject({ ok: true });
    expect(pluginBackendHostMessageSchema.parse({
      type: "result",
      callId: "00000000-0000-4000-8000-000000000000",
      ok: false,
      error: "failed"
    })).toMatchObject({ ok: false });
  });
});
