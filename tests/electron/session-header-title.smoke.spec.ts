import { execFile } from "node:child_process";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import { visualCaptureResultPrefix } from "../../scripts/visual-capture/result";

for (const [state, width, theme] of [
  ["long-title", 800, "dark"],
  ["long-title", 1440, "light"],
  ["short-title", 1000, "light"],
  ["long-subagent-title", 1024, "light"],
  ["long-subagent-title", 800, "dark"],
  ["project-chat", 1024, "light"],
  ["project-chat", 800, "light"],
] as const) {
  test(`session header ${state} at ${width}px (${theme})`, async () => {
    test.setTimeout(60_000);
    const repository = resolve(import.meta.dirname, "../..");
    const output = test.info().outputPath("header.png");
    // Use the supported bundled CLI: the scenario graph includes CSS/raw imports.
    // The scenario asserts real ellipsis/overflow geometry, adjacent hit targets,
    // mode switching and breadcrumb navigation in an isolated Electron app.
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        join(repository, "scripts/visual-capture/run.mjs"),
        "session-header-title",
        "--state",
        state,
        "--width",
        String(width),
        "--height",
        "760",
        "--theme",
        theme,
        "--output",
        output,
        "--no-build",
      ],
      { cwd: repository, timeout: 50_000 },
    );
    const line = stdout.split("\n").find((line) => line.startsWith(visualCaptureResultPrefix));
    expect(line).toBeDefined();
    expect(JSON.parse(line!.slice(visualCaptureResultPrefix.length))).toMatchObject({
      scenario: "session-header-title",
      state,
      outputPath: output,
    });
    await test.info().attach("Session header", { path: output, contentType: "image/png" });
  });
}
