import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import { visualCaptureResultPrefix } from "../../scripts/visual-capture/result";

for (const [state, width, theme] of [
  ["todos", 1280, "light"],
  ["todos", 760, "dark"],
  ["sessions", 760, "light"],
  ["terminal", 760, "dark"],
] as const) {
  test(`application icons and compact ${state} at ${width}px in ${theme}`, async () => {
    const repository = resolve(import.meta.dirname, "../..");
    const output = test.info().outputPath("icons.png");
    // Use the supported bundled CLI: the scenario graph contains CSS/raw imports
    // that Playwright's direct source importer cannot load.
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        join(repository, "scripts/visual-capture/run.mjs"),
        "interface-icons",
        "--state",
        state,
        "--theme",
        theme,
        "--width",
        String(width),
        "--height",
        "800",
        "--capture",
        "window",
        "--output",
        output,
        "--no-build",
      ],
      { cwd: repository, timeout: 30_000 },
    );
    const line = stdout.split("\n").find((line) => line.startsWith(visualCaptureResultPrefix));
    expect(line).toBeDefined();
    expect(JSON.parse(line!.slice(visualCaptureResultPrefix.length))).toMatchObject({
      scenario: "interface-icons",
      state,
      dimensions: { width, height: 800 },
      outputPath: output,
    });
    expect((await readFile(output)).subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    await test.info().attach("Icon hierarchy", { path: output, contentType: "image/png" });
  });
}
