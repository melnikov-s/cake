import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { parseVisualCaptureArguments } from "../../scripts/visual-capture/arguments";
import { captureVisual } from "../../scripts/visual-capture/capture";

test("captures a highlighted assistant code block from the compiled Electron app", async () => {
  const outputRoot = await mkdtemp(join(tmpdir(), "cake-visual-capture-smoke-output-"));
  const output = join(outputRoot, "assistant-hover.png");
  let isolatedRoot: string | undefined;

  try {
    const options = parseVisualCaptureArguments([
      "assistant-markdown-code",
      "--state",
      "hover",
      "--theme",
      "dark",
      "--width",
      "1000",
      "--height",
      "760",
      "--output",
      output,
      "--no-build",
    ]);
    const result = await captureVisual(options, {
      onTemporaryRoot: (path) => {
        isolatedRoot = path;
      },
    });

    const png = await readFile(output);
    expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(result).toMatchObject({
      schemaVersion: 1,
      scenario: "assistant-markdown-code",
      state: "hover",
      outputPath: output,
      mimeType: "image/png",
      checksum: `sha256:${createHash("sha256").update(png).digest("hex")}`,
    });
    expect(result.dimensions.width).toBeGreaterThan(400);
    expect(result.dimensions.height).toBeGreaterThan(200);
    expect(isolatedRoot).toBeDefined();
    await expect(stat(isolatedRoot!)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(outputRoot, { recursive: true, force: true });
  }
});
