import { describe, expect, it } from "vitest";
import { promptText } from "../../../../src/services/pi/runtime/session-projection";

describe("promptText file attachments", () => {
  it("quotes selected file paths with whitespace while leaving backend-owned references unchanged", () => {
    expect(
      promptText("Inspect", [
        { kind: "file", name: "sample.txt", path: "/device/My Files/sample.txt" },
      ]),
    ).toBe('Inspect\n\n@"/device/My Files/sample.txt"');
    expect(
      promptText("Inspect", [
        { kind: "file", name: "sample.txt", path: "/server/cache/accepted/id" },
      ]),
    ).toBe("Inspect\n\n@/server/cache/accepted/id");
  });
});
