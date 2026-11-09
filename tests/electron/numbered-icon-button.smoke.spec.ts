import { execFile } from "node:child_process";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import { visualCaptureResultPrefix } from "../../scripts/visual-capture/result";

for (const count of [0, 7, 12, "large"] as const) {
  for (const theme of ["light", "dark"] as const) {
    test(`numbered icon count ${count} in ${theme}`, async () => {
      await capture(count, theme, "default", 1280);
    });
  }
}

for (const [count, state] of [
  [7, "hover"],
  ["large", "focus"],
] as const) {
  test(`numbered icon ${state} in narrow chrome`, async () => {
    await capture(count, "dark", state, 760);
  });
}

async function capture(
  count: number | "large",
  theme: "light" | "dark",
  state: string,
  width: number,
) {
  test.setTimeout(90_000);
  const repository = resolve(import.meta.dirname, "../..");
  const scenario = `numbered-icon-buttons-${count}`;
  const output = test.info().outputPath("numbered-icons.png");
  // The supported CLI bundles the scenario graph's CSS/raw imports.
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      join(repository, "scripts/visual-capture/run.mjs"),
      scenario,
      "--theme",
      theme,
      "--state",
      state,
      "--width",
      String(width),
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
    outputPath: output,
  });
  await test.info().attach("Numbered icons", { path: output, contentType: "image/png" });
}
