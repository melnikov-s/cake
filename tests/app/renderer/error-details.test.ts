import { describe, expect, it } from "vitest";
import { describeError } from "../../../src/renderer/lib/error-details";

describe("describeError", () => {
  it("keeps an Error stack while exposing its concise message", () => {
    const error = new Error("Identity collision");
    const described = describeError(error);

    expect(described.message).toBe("Identity collision");
    expect(described.details).toContain("Error: Identity collision");
    expect(described.details).toContain("error-details.test.ts");
  });

  it("uses a string as both the message and available details", () => {
    expect(describeError("Operation failed")).toEqual({
      message: "Operation failed",
      details: "Operation failed",
    });
  });

  it("adds operation context without replacing the original stack", () => {
    const described = describeError(
      new Error("Identity collision"),
      "Desktop event: review-threads-received",
    );

    expect(described.details).toContain("Error: Identity collision");
    expect(described.details).toContain("Context:\nDesktop event: review-threads-received");
  });
});
