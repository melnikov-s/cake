import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "@playwright/test";
import { parseVisualCaptureArguments } from "../../scripts/visual-capture/arguments";
import { captureVisual } from "../../scripts/visual-capture/capture";

// The scenario asserts real Electron geometry, one-line ellipsis, full assignment
// access, and independent disclosure/fullscreen operation, not just CSS classes.
for (const [state, theme, width] of [
  ["completed", "dark", 1000],
  ["completed", "light", 820],
  ["failed", "dark", 820],
  ["failed-start", "light", 760],
  ["aborted", "dark", 760],
  ["queued", "light", 820],
  ["running", "dark", 820],
  ["collapsed", "dark", 760],
] as const) {
  test(`report header ${state} stays contained (${theme}, ${width}px)`, async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), "cake-report-header-"));
    try {
      await captureVisual(
        parseVisualCaptureArguments([
          "report-headers",
          "--state",
          state,
          "--theme",
          theme,
          "--width",
          String(width),
          "--height",
          "760",
          "--output",
          join(outputRoot, "header.png"),
          "--no-build",
        ]),
      );
    } finally {
      await rm(outputRoot, { recursive: true, force: true });
    }
  });
}
