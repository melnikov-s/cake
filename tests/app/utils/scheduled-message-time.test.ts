import { describe, expect, it } from "vitest";
import { parseScheduledMessage } from "../../../src/utils/scheduled-message-time";

const now = Date.parse("2026-09-04T12:00:00.000Z");

describe("parseScheduledMessage", () => {
  it("parses relative durations", () => {
    expect(parseScheduledMessage("20m Check the build", now)).toEqual({
      sendAt: "2026-09-04T12:20:00.000Z",
      text: "Check the build",
    });
    expect(parseScheduledMessage("2h Review the result", now).sendAt).toBe(
      "2026-09-04T14:00:00.000Z",
    );
  });

  it("parses future ISO timestamps", () => {
    expect(parseScheduledMessage("2026-09-05T09:30:00.000Z Continue the work", now)).toEqual({
      sendAt: "2026-09-05T09:30:00.000Z",
      text: "Continue the work",
    });
  });

  it("rejects missing messages and past times", () => {
    expect(() => parseScheduledMessage("20m", now)).toThrow(/Usage/);
    expect(() => parseScheduledMessage("2026-09-03T09:30:00.000Z Too late", now)).toThrow(/future/);
  });
});
