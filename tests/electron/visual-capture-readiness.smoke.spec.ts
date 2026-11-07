import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import { visualCaptureResultPrefix } from "../../scripts/visual-capture/result";

// Exercise the supported bundled CLI, not Playwright's direct source importer:
// the scenario graph includes application CSS/raw imports handled by that bundler.
test("captures Project Chat navigation after restoring a Project Session before chat catalog readiness", async () => {
  const repository = resolve(import.meta.dirname, "../..");
  const output = test.info().outputPath("project-chat-ready.png");
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      join(repository, "scripts/visual-capture/run.mjs"),
      "chat-first-navigation",
      "--state",
      "sessions",
      "--capture",
      "window",
      "--output",
      output,
      "--no-build",
    ],
    { cwd: repository, timeout: 25_000 },
  );

  // The scenario must reach the real Project Chat composer, seeded transcript
  // and Sessions pane before it can publish an image. A visible rail alone
  // previously led to a failed navigation and missing-composer timeout here.
  const line = stdout.split("\n").find((line) => line.startsWith(visualCaptureResultPrefix));
  expect(line).toBeDefined();
  const result = JSON.parse(line!.slice(visualCaptureResultPrefix.length));
  const png = await readFile(output);
  expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  expect(result).toMatchObject({
    scenario: "chat-first-navigation",
    state: "sessions",
    dimensions: { width: 1280, height: 900 },
    outputPath: output,
    checksum: `sha256:${createHash("sha256").update(png).digest("hex")}`,
  });
  await test.info().attach("Project Chat ready", { path: output, contentType: "image/png" });
});
