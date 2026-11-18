import { execFile } from "node:child_process";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import { visualCaptureResultPrefix } from "../../scripts/visual-capture/result";

for (const [state, theme] of [
  ["default", "light"],
  ["open", "dark"],
] as const) {
  test(`worktree composer Activity ${state} (${theme})`, async ({}, testInfo) => {
    test.setTimeout(60_000);
    const repository = resolve(import.meta.dirname, "../..");
    const output = testInfo.outputPath(`activity-${state}-${theme}.png`);
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        join(repository, "scripts/visual-capture/run.mjs"),
        "activity-worktree-cap",
        "--state",
        state,
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
      scenario: "activity-worktree-cap",
      state,
      outputPath: output,
    });
    await testInfo.attach("Worktree Activity", { path: output, contentType: "image/png" });
  });
}
