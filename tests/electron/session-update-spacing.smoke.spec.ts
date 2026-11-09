import { execFile } from "node:child_process";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import { visualCaptureResultPrefix } from "../../scripts/visual-capture/result";

for (const [width, theme] of [
  [1024, "light"],
  [1024, "dark"],
  [760, "light"],
] as const) {
  for (const state of ["default", "expanded"]) {
    test(`session update stack stays compact (${state}, ${theme}, ${width}px)`, async () => {
      const repository = resolve(import.meta.dirname, "../..");
      const output = join(
        repository,
        ".visual-captures",
        `session-update-spacing-${state}-${theme}-${width}.png`,
      );
      // The supported bundled CLI handles CSS/raw imports in the scenario graph.
      // The scenario checks real card/target/virtual-row geometry before and
      // after expansion, in an isolated app backed by a seeded transcript.
      const { stdout } = await promisify(execFile)(
        process.execPath,
        [
          join(repository, "scripts/visual-capture/run.mjs"),
          "session-update-spacing",
          "--state",
          state,
          "--theme",
          theme,
          "--width",
          String(width),
          "--height",
          "700",
          "--output",
          output,
          "--no-build",
        ],
        { cwd: repository, timeout: 30_000 },
      );
      const line = stdout.split("\n").find((line) => line.startsWith(visualCaptureResultPrefix));
      expect(line).toBeDefined();
      expect(JSON.parse(line!.slice(visualCaptureResultPrefix.length))).toMatchObject({
        scenario: "session-update-spacing",
        state,
        outputPath: output,
      });
      await test
        .info()
        .attach("Compact session update stack", { path: output, contentType: "image/png" });
    });
  }
}
