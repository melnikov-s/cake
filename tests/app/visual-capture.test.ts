import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseVisualCaptureArguments } from "../../scripts/visual-capture/arguments";
import {
  formatVisualCaptureResult,
  visualCaptureResultPrefix,
  type VisualCaptureResult,
} from "../../scripts/visual-capture/result";

describe("visual capture arguments", () => {
  it("applies deterministic defaults", () => {
    expect(parseVisualCaptureArguments(["assistant-markdown-code"], "/workspace")).toEqual({
      scenario: "assistant-markdown-code",
      state: "default",
      theme: "dark",
      width: 1280,
      height: 900,
      capture: "region",
      outputDirectory: resolve("/workspace/.visual-captures"),
      build: true,
      help: false,
      list: false,
    });
  });

  it("parses named state, display, output, and build controls", () => {
    expect(
      parseVisualCaptureArguments(
        [
          "assistant-markdown-code",
          "--state=hover",
          "--theme",
          "light",
          "--width",
          "1440",
          "--height=1000",
          "--capture",
          "window",
          "--output",
          "review/capture.png",
          "--no-build",
        ],
        "/workspace",
      ),
    ).toMatchObject({
      scenario: "assistant-markdown-code",
      state: "hover",
      theme: "light",
      width: 1440,
      height: 1000,
      capture: "window",
      output: resolve("/workspace/review/capture.png"),
      build: false,
    });
  });

  it("rejects missing scenarios, invalid dimensions, and ambiguous output", () => {
    expect(() => parseVisualCaptureArguments([], "/workspace")).toThrow("A scenario is required");
    expect(() =>
      parseVisualCaptureArguments(["assistant-markdown-code", "--width", "200"], "/workspace"),
    ).toThrow("--width must be an integer between 320 and 3840");
    expect(() =>
      parseVisualCaptureArguments(
        ["assistant-markdown-code", "--output", "one.png", "--output-dir", "captures"],
        "/workspace",
      ),
    ).toThrow("Use either --output or --output-dir");
  });
});

describe("visual capture result output", () => {
  it("emits a stable prefixed JSON record", () => {
    const result: VisualCaptureResult = {
      schemaVersion: 1,
      scenario: "assistant-markdown-code",
      state: "hover",
      dimensions: { width: 640, height: 480 },
      outputPath: "/workspace/capture.png",
      mimeType: "image/png",
      checksum: `sha256:${"a".repeat(64)}`,
    };

    const line = formatVisualCaptureResult(result);
    expect(line.startsWith(visualCaptureResultPrefix)).toBe(true);
    expect(JSON.parse(line.slice(visualCaptureResultPrefix.length))).toEqual(result);
  });
});
