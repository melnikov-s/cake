import { describe, expect, it } from "vitest";
import { formatRelativeSessionTime } from "../../../../src/renderer/models/session-activity-time";

describe("formatRelativeSessionTime", () => {
  const now = Date.parse("2026-08-16T12:00:00.000Z");

  it("uses relative labels for recent session activity", () => {
    expect(formatRelativeSessionTime(new Date(now - 20 * 60_000).toISOString(), now)).toBe("20 min ago");
    expect(formatRelativeSessionTime(new Date(now - 2 * 3_600_000).toISOString(), now)).toBe("2 hrs ago");
    expect(formatRelativeSessionTime(new Date(now - 2 * 86_400_000).toISOString(), now)).toBe("2 days ago");
  });

  it("uses a calendar date for older activity", () => {
    expect(formatRelativeSessionTime("2026-07-01T12:00:00.000Z", now)).toContain("Jul");
    expect(formatRelativeSessionTime("2025-07-01T12:00:00.000Z", now)).toContain("2025");
  });
});
