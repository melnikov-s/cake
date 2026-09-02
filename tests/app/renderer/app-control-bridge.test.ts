import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { CakeChatTarget } from "../../../src/domain/cake-chat-data";
import { listAppControlTools } from "../../../src/renderer/app-control-bridge";

describe("AppControlBridge", () => {
  it("constructs a Cake Chat RPC target without explicit undefined optional fields", () => {
    const target = {
      sessionId: "9f0de1b1-4baa-4706-9a41-1b9e3c90b404",
      tools: listAppControlTools(),
    };

    expect(() => Schema.decodeUnknownSync(CakeChatTarget)(target)).not.toThrow();
    expect(
      target.tools
        .filter((tool) => tool.topic !== "customizations")
        .every((tool) => !("guidance" in tool)),
    ).toBe(true);
  });
});
