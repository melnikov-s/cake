import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import { visualCaptureResultPrefix } from "../../scripts/visual-capture/result";

for (const [scenario, state, width, theme] of [
  ["project-thumbnails", "expanded", 1280, "light"],
  ["project-thumbnails", "compact", 1280, "dark"],
  ["project-thumbnails", "compact", 760, "light"],
  ["interface-icons", "todos", 1280, "light"],
  ["interface-icons", "todos", 760, "dark"],
  ["interface-icons", "sessions", 760, "light"],
  ["interface-icons", "terminal", 760, "dark"],
  ["interface-icons", "actions", 1280, "light"],
  ["interface-icons", "actions", 1280, "dark"],
  ["interface-icons-auto-merge", "default", 1280, "light"],
  ["interface-icons-auto-merge", "default", 1280, "dark"],
] as const) {
  test(`${scenario} ${state} at ${width}px in ${theme}`, async () => {
    test.setTimeout(90_000);
    const repository = resolve(import.meta.dirname, "../..");
    const output = test.info().outputPath("icons.png");
    // Use the supported bundled CLI: the scenario graph contains CSS/raw imports
    // that Playwright's direct source importer cannot load.
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        join(repository, "scripts/visual-capture/run.mjs"),
        scenario,
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
      { cwd: repository, timeout: 80_000 },
    );
    const line = stdout.split("\n").find((line) => line.startsWith(visualCaptureResultPrefix));
    expect(line).toBeDefined();
    expect(JSON.parse(line!.slice(visualCaptureResultPrefix.length))).toMatchObject({
      scenario,
      state,
      dimensions: { width, height: 800 },
      outputPath: output,
    });
    expect((await readFile(output)).subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    await test.info().attach("Icon hierarchy", { path: output, contentType: "image/png" });
  });
}
