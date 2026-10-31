/** @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
import {
  captureAnnotationText,
  numberedCaptureDrawings,
  type CaptureDrawing,
} from "../../../src/contracts/desktop/screen-capture-data";
import { captureMarker, paintCapture } from "../../../src/renderer/screen-capture/render-capture";

const drawings: CaptureDrawing[] = [
  {
    kind: "arrow",
    start: { x: 100, y: 100 },
    end: { x: 20, y: 20 },
    label: "First\n  indented\n\nlast",
  },
  {
    kind: "freehand",
    points: [
      { x: 600, y: 400 },
      { x: 700, y: 500 },
      { x: 600, y: 400 },
    ],
    label: "Second",
  },
];

describe("numbered screenshot export", () => {
  it("preserves multiline text, blank lines, drawing order and numbering for both tools", () => {
    expect(captureAnnotationText(drawings)).toBe(
      "1. First\n     indented\n   \n   last\n2. Second",
    );
    expect(captureAnnotationText([drawings[1]!])).toBe("1. Second");
    expect(captureAnnotationText(Array.from({ length: 10 }, () => drawings[0]!))).toContain(
      "10. First\n      indented\n    \n    last",
    );
  });
  it("uses the same crop projection without assigning another annotation's number", () => {
    const rect = { x: 650, y: 450, width: 100, height: 100 };
    expect(numberedCaptureDrawings(drawings, rect).map(({ number }) => number)).toEqual([2]);
    expect(captureAnnotationText(drawings, rect)).toBe("2. Second");
    // A crop inside the bounding box but away from the actual line has no orphan note.
    expect(captureAnnotationText(drawings, { x: 20, y: 80, width: 10, height: 10 })).toBe("");
    const marker = captureMarker({ x: 600, y: 400 }, 1200, 800, rect);
    expect(marker.x - marker.radius).toBeGreaterThanOrEqual(rect.x);
    expect(marker.y - marker.radius).toBeGreaterThanOrEqual(rect.y);
  });
  it("paints only the numeric labels and keeps closed freehand strokes", () => {
    const context = {
      clearRect: vi.fn(),
      drawImage: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: vi.fn(),
      arc: vi.fn(),
      fill: vi.fn(),
      fillText: vi.fn(),
    } as unknown as CanvasRenderingContext2D;
    const image = document.createElement("img");
    Object.defineProperties(image, {
      naturalWidth: { value: 1200 },
      naturalHeight: { value: 800 },
    });
    paintCapture(context, image, drawings, {
      ink: "blue",
      background: "white",
      foreground: "black",
    });
    expect(vi.mocked(context.fillText).mock.calls.map(([text]) => text)).toEqual(["1", "2"]);
    expect(context.lineTo).toHaveBeenCalledWith(700, 500);
    expect(context.lineTo).toHaveBeenCalledWith(600, 400);
    expect(context.arc).toHaveBeenCalledTimes(2);
  });
});
