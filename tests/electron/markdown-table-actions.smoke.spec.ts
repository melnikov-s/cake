import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { parseVisualCaptureArguments } from "../../scripts/visual-capture/arguments";
import { captureVisual } from "../../scripts/visual-capture/capture";

for (const [width, theme] of [
  [1024, "dark"],
  [760, "light"],
] as const) {
  test(`table actions stay painted across scroll and hover changes (${theme})`, async () => {
    // The named scenario samples opacity during real wheel scrolling, checks
    // stable geometry, and exercises keyboard fullscreen and the copy menu.
    const result = await captureVisual(
      parseVisualCaptureArguments([
        "assistant-markdown-table",
        "--theme",
        theme,
        "--width",
        String(width),
        "--height",
        "900",
        "--output",
        resolve(`.visual-captures/markdown-table-${theme}.png`),
        "--no-build",
      ]),
    );
    expect(result.dimensions.width).toBeGreaterThan(0);
  });
}
