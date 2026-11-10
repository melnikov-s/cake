import { execFile } from "node:child_process";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import { visualCaptureResultPrefix } from "../../scripts/visual-capture/result";

for (const [scenario, state, width, theme] of [
  ["session-update-spacing", "default", 1024, "light"],
  ["session-update-spacing", "default", 1024, "dark"],
  ["session-update-spacing", "narrow", 760, "light"],
  ["session-update-spacing", "narrow", 760, "dark"],
  ["compact-session-reports", "default", 1024, "light"],
  ["compact-session-reports", "narrow", 760, "dark"],
] as const) {
  test(`${scenario} has compact aligned controls (${state}, ${theme}, ${width}px)`, async () => {
    const repository = resolve(import.meta.dirname, "../..");
    const output = join(
      repository,
      ".visual-captures",
      `${scenario}-${state}-${theme}-${width}.png`,
    );
    // The supported bundled CLI handles CSS/raw imports in the scenario graph.
    // Scenarios check real geometry, to-do/session/source destinations and report
    // access in an isolated app backed by seeded transcripts.
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
        "700",
        "--output",
        output,
        "--no-build",
      ],
      { cwd: repository, timeout: 60_000 },
    );
    const line = stdout.split("\n").find((line) => line.startsWith(visualCaptureResultPrefix));
    expect(line).toBeDefined();
    expect(JSON.parse(line!.slice(visualCaptureResultPrefix.length))).toMatchObject({
      scenario,
      state,
      outputPath: output,
    });
    await test.info().attach(scenario, { path: output, contentType: "image/png" });
  });
}
