import { describe, expect, it } from "vitest";
import { boundSessionAssistantMessages } from "../../../src/services/pi/runtime/session-assistant";

describe("session assistant context", () => {
  it("keeps the newest messages within the character budget", () => {
    expect(
      boundSessionAssistantMessages(
        [
          { role: "user", text: "old question" },
          { role: "assistant", text: "middle answer" },
          { role: "user", text: "new request" },
        ],
        15,
      ),
    ).toEqual([
      { role: "assistant", text: "swer" },
      { role: "user", text: "new request" },
    ]);
  });

  it("drops empty messages", () => {
    expect(
      boundSessionAssistantMessages(
        [
          { role: "user", text: "   " },
          { role: "assistant", text: " Ready " },
        ],
        100,
      ),
    ).toEqual([{ role: "assistant", text: "Ready" }]);
  });
});
