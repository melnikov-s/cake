import { describe, expect, it } from "vitest";
import {
  chatDropTargets,
  containsPoint,
  widgetDropOrder,
} from "../../../src/renderer/lib/widget-placement";

describe("widget placement geometry", () => {
  it("provides all four empty destinations relative to the available chat, not the window", () => {
    const targets = chatDropTargets({ left: 200, top: 80, width: 800, height: 600 });
    expect(targets.map((target) => target.slot)).toEqual(["top", "bottom", "left", "right"]);
    for (const [slot, x, y] of [
      ["top", 600, 100],
      ["bottom", 600, 650],
      ["left", 220, 380],
      ["right", 980, 380],
    ] as const) {
      expect(
        targets.filter((target) => containsPoint(target.rect, x, y)).map((target) => target.slot),
      ).toEqual([slot]);
    }
    expect(targets.some((target) => containsPoint(target.rect, 600, 380))).toBe(false);
    expect(targets.some((target) => containsPoint(target.rect, 10, 10))).toBe(false);
  });

  it("inserts above or below sibling midpoints and ignores absent geometry", () => {
    const siblings = [
      { id: "offscreen", order: 0 },
      { id: "first", order: 1, rect: { left: 10, top: 100, width: 200, height: 100 } },
      { id: "second", order: 2, rect: { left: 10, top: 200, width: 200, height: 100 } },
    ];
    expect(widgetDropOrder(siblings, 125)).toBe(1);
    expect(widgetDropOrder(siblings, 175)).toBe(2);
    expect(widgetDropOrder(siblings, 300)).toBeUndefined();
  });
});
