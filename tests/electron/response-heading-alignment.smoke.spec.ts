import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { parseVisualCaptureArguments } from "../../scripts/visual-capture/arguments";
import { captureVisual } from "../../scripts/visual-capture/capture";

for (const [width, theme] of [
  [1024, "dark"],
  [760, "light"],
] as const) {
  for (const state of ["default", "expanded", "note"]) {
    test(`response headings share gutters (${state}, ${theme}, ${width}px)`, async () => {
      const outputRoot = await mkdtemp(join(tmpdir(), "cake-response-headings-"));
      try {
        // The named scenario checks title/chevron geometry, wrapping, and retained
        // body nesting for standalone, batched exact-source, and batch-note paths.
        const result = await captureVisual(
          parseVisualCaptureArguments([
            "session-update-reports",
            "--state",
            state,
            "--theme",
            theme,
            "--width",
            String(width),
            "--height",
            "1000",
            "--output",
            join(outputRoot, "headings.png"),
            "--no-build",
          ]),
        );
        expect(result.dimensions.width).toBeGreaterThan(0);
      } finally {
        await rm(outputRoot, { recursive: true, force: true });
      }
    });
  }
}
