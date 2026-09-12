import { describe, expect, it } from "vitest";
import { mergedSessionLabelColor } from "../../../src/utils/session-label-color";

describe("mergedSessionLabelColor", () => {
  it("preserves a single label color exactly", () => {
    expect(mergedSessionLabelColor(["violet"])).toBe("#9a78d7");
  });

  it("weights the primary label by half and splits the remainder between secondary labels", () => {
    const primaryBlue = mergedSessionLabelColor(["blue", "rose", "green"]);
    const primaryRose = mergedSessionLabelColor(["rose", "blue", "green"]);
    const reorderedSecondary = mergedSessionLabelColor(["blue", "green", "rose"]);

    expect(primaryBlue).toMatch(/^oklch\(/);
    expect(primaryBlue).not.toBe(primaryRose);
    expect(primaryBlue).toBe(reorderedSecondary);
  });

  it("returns no color for an unlabelled session", () => {
    expect(mergedSessionLabelColor([])).toBeUndefined();
  });
});
