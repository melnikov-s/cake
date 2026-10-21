import { describe, expect, it } from "vitest";
import {
  formatCountdown,
  formatRepeatInterval,
  parseScheduledMessage,
} from "../../../src/utils/scheduled-message-time";

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

describe("scheduled countdown labels", () => {
  it("counts down in minutes and seconds under an hour, then hours and minutes", () => {
    expect(formatCountdown(0)).toBe("0:00");
    expect(formatCountdown(14_200)).toBe("0:15");
    expect(formatCountdown(161_000)).toBe("2:41");
    expect(formatCountdown(3_599_000)).toBe("59:59");
    expect(formatCountdown(3_600_000)).toBe("1h");
    expect(formatCountdown(80 * 60_000)).toBe("1h 20m");
  });

  it("names recurring intervals in their largest whole unit", () => {
    expect(formatRepeatInterval(90)).toBe("90s");
    expect(formatRepeatInterval(180)).toBe("3m");
    expect(formatRepeatInterval(7_200)).toBe("2h");
    expect(formatRepeatInterval(604_800)).toBe("7d");
  });
});
