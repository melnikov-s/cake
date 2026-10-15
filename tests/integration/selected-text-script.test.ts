import { describe, expect, it } from "vitest";
import { runOsaScript, SELECTED_TEXT_SCRIPT } from "../../src/services/electron/selected-text";

// Runs only the Accessibility read; the copy fallback would post Command+C to whatever app
// is frontmost on the developer's machine.
describe.runIf(process.platform === "darwin")("macOS selected-text script", () => {
  it("compiles under JavaScript for Automation and reports the frontmost app", async () => {
    const output: unknown = JSON.parse(await runOsaScript(SELECTED_TEXT_SCRIPT, []));
    expect(output).toEqual({
      text: expect.any(String),
      application: expect.any(String),
      source: "accessibility",
    });
  });
});
