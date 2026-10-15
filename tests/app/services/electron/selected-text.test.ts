import { describe, expect, it, vi } from "vitest";
import {
  readSelectedText,
  SELECTED_TEXT_SCRIPT,
  type SelectedTextReaderOptions,
} from "../../../../src/services/electron/selected-text";

function reader(overrides: Partial<SelectedTextReaderOptions> = {}) {
  const runScript = vi.fn<SelectedTextReaderOptions["runScript"]>(async () =>
    JSON.stringify({ text: "Selected words", application: "Safari", source: "accessibility" }),
  );
  const options: SelectedTextReaderOptions = {
    platform: "darwin",
    accessibilityTrusted: () => true,
    runScript,
    clipboardFallback: true,
    ...overrides,
  };
  return { options, runScript };
}

describe("Selected text capture", () => {
  it("reads the frontmost selection and asks the script to fall back to copying", async () => {
    const { options, runScript } = reader();
    await expect(readSelectedText(options)).resolves.toEqual({
      kind: "text",
      selection: { text: "Selected words", application: "Safari" },
    });
    expect(runScript).toHaveBeenCalledWith(SELECTED_TEXT_SCRIPT, ["copy"]);
    const { options: accessibilityOnly, runScript: run } = reader({ clipboardFallback: false });
    await readSelectedText(accessibilityOnly);
    expect(run).toHaveBeenCalledWith(SELECTED_TEXT_SCRIPT, []);
  });

  it("reports missing Accessibility permission without running the script", async () => {
    const { options, runScript } = reader({ accessibilityTrusted: () => false });
    await expect(readSelectedText(options)).resolves.toEqual({ kind: "permission-denied" });
    expect(runScript).not.toHaveBeenCalled();
  });

  it("treats whitespace, other platforms, and script failures as no selection", async () => {
    const blank = reader({
      runScript: async () => JSON.stringify({ text: " \n", application: "" }),
    });
    await expect(readSelectedText(blank.options)).resolves.toEqual({ kind: "none" });
    const linux = reader({ platform: "linux" });
    await expect(readSelectedText(linux.options)).resolves.toEqual({ kind: "none" });
    expect(linux.runScript).not.toHaveBeenCalled();
    const failing = reader({
      runScript: async () => {
        throw new Error("Command failed: osascript timed out");
      },
    });
    await expect(readSelectedText(failing.options)).resolves.toEqual({
      kind: "failed",
      message: "Command failed: osascript timed out",
    });
    const garbled = reader({ runScript: async () => "not json" });
    await expect(readSelectedText(garbled.options)).resolves.toMatchObject({ kind: "failed" });
  });

  it("saves and restores the pasteboard around the copy fallback", () => {
    // The fallback must never leave the user's clipboard replaced by the copied selection.
    const copy = SELECTED_TEXT_SCRIPT.slice(SELECTED_TEXT_SCRIPT.indexOf("function readByCopying"));
    expect(copy.indexOf("dataForType")).toBeLessThan(copy.indexOf("CGEventPost"));
    expect(copy.indexOf("CGEventPost")).toBeLessThan(copy.indexOf("writeObjects"));
  });
});
