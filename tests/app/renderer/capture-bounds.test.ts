import { describe, expect, it } from "vitest";
import {
  adjustCaptureBounds,
  automaticCaptureBounds,
  type CaptureBoundsHandle,
} from "../../../src/renderer/screen-capture/capture-bounds";

describe("automatic capture bounds in screenshot pixels", () => {
  it("uses the whole captured display without drawings", () => {
    expect(automaticCaptureBounds([], 2400, 1200)).toEqual({
      x: 0,
      y: 0,
      width: 2400,
      height: 1200,
    });
  });
  it("unions centered arrow endpoints and freehand points with 300px padding on each side", () => {
    expect(
      automaticCaptureBounds(
        [
          { kind: "arrow", start: { x: 600, y: 400 }, end: { x: 400, y: 600 }, label: "Arrow" },
          {
            kind: "freehand",
            points: [
              { x: 700, y: 500 },
              { x: 900, y: 400 },
              { x: 800, y: 700 },
            ],
            label: "Curve",
          },
        ],
        2400,
        1200,
      ),
    ).toEqual({ x: 100, y: 100, width: 1100, height: 900 });
  });
  it("clamps padding at every display boundary", () => {
    expect(
      automaticCaptureBounds(
        [
          {
            kind: "freehand",
            points: [
              { x: 200, y: 200 },
              { x: 2200, y: 1000 },
            ],
            label: "",
          },
        ],
        2400,
        1200,
      ),
    ).toEqual({ x: 0, y: 0, width: 2400, height: 1200 });
  });
});

describe("capture rectangle adjustments", () => {
  const rect = { x: 200, y: 200, width: 400, height: 300 };
  it.each([
    ["move", { x: 220, y: 230, width: 400, height: 300 }],
    ["n", { x: 200, y: 230, width: 400, height: 270 }],
    ["ne", { x: 200, y: 230, width: 420, height: 270 }],
    ["e", { x: 200, y: 200, width: 420, height: 300 }],
    ["se", { x: 200, y: 200, width: 420, height: 330 }],
    ["s", { x: 200, y: 200, width: 400, height: 330 }],
    ["sw", { x: 220, y: 200, width: 380, height: 330 }],
    ["w", { x: 220, y: 200, width: 380, height: 300 }],
    ["nw", { x: 220, y: 230, width: 380, height: 270 }],
  ] satisfies [CaptureBoundsHandle, typeof rect][])("adjusts %s", (handle, expected) => {
    expect(adjustCaptureBounds(rect, handle, { x: 20, y: 30 }, 1200, 800)).toEqual(expected);
  });
  it("keeps movement inside the image without changing size", () => {
    expect(adjustCaptureBounds(rect, "move", { x: -1000, y: 1000 }, 1200, 800)).toEqual({
      x: 0,
      y: 500,
      width: 400,
      height: 300,
    });
  });
  it("clamps resizing to the image and prevents inverted/empty bounds", () => {
    expect(adjustCaptureBounds(rect, "nw", { x: -1000, y: -1000 }, 1200, 800)).toEqual({
      x: 0,
      y: 0,
      width: 600,
      height: 500,
    });
    expect(adjustCaptureBounds(rect, "se", { x: -1000, y: -1000 }, 1200, 800)).toEqual({
      x: 200,
      y: 200,
      width: 2,
      height: 2,
    });
  });
});
