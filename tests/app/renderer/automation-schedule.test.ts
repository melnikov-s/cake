import { describe, expect, it } from "vitest";
import {
  calendarControls,
  calendarExpression,
  intervalUnit,
} from "../../../src/renderer/lib/automation-schedule";

describe("friendly automation repeat controls", () => {
  it.each([
    ["30 9 * * *", "daily"],
    ["0 9 * * 1-5", "weekdays"],
    ["15 17 * * 3", "weekly"],
    ["0 8 15 * *", "monthly"],
  ])("round-trips %s through %s without displaying cron", (expression, repeat) => {
    const controls = calendarControls({
      _tag: "Calendar",
      expression,
      timeZone: "America/Los_Angeles",
      startsAt: "2030-01-01T00:00:00.000Z",
    });
    expect(controls.repeat).toBe(repeat);
    expect(calendarExpression(controls)).toBe(expression);
  });
  it.each(["0 9 * * 1,3,5", "0 9 1 * 1"])(
    "keeps unsupported calendar rule %s explicitly custom",
    (expression) => {
      expect(
        calendarControls({
          _tag: "Calendar",
          expression,
          timeZone: "UTC",
          startsAt: "2030-01-01T00:00:00.000Z",
        }).repeat,
      ).toBe("custom");
    },
  );
  it("retains exact interval precision rather than rounding accepted seconds", () => {
    expect([61, 120, 7200, 86400].map(intervalUnit)).toEqual([1, 60, 3600, 86400]);
  });
});
