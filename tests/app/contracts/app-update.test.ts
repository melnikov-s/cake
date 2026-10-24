import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { AppUpdate, isNewerVersion } from "../../../src/contracts/application/app-update";

describe("stable macOS releases", () => {
  it.each([
    ["0.1.1", "0.1.0", true],
    ["0.10.0", "0.9.9", true],
    ["1.0.0", "0.99.99", true],
    ["1.0.0", "1.0.0", false],
    ["0.9.0", "0.10.0", false],
    ["1.0.0-beta.1", "0.1.0", false],
    ["v1.0.0", "0.1.0", false],
    ["01.0.0", "0.1.0", false],
    ["1.0.0", "not-a-version", false],
  ])("compares %s with %s", (available, installed, expected) => {
    expect(isNewerVersion(available, installed)).toBe(expected);
  });

  it("accepts only the matching public release DMG", () => {
    const update = {
      version: "0.2.0",
      downloadUrl:
        "https://github.com/melnikov-s/cake/releases/download/v0.2.0/Cake-0.2.0-mac-arm64.dmg",
      sha256: "a".repeat(64),
    };
    expect(Schema.is(AppUpdate)(update)).toBe(true);
    for (const downloadUrl of [
      "https://example.com/Cake.dmg",
      "file:///Applications/Cake.app",
      "https://github.com/melnikov-s/cake/releases/download/v0.1.0/Cake-0.1.0-mac-arm64.dmg",
    ])
      expect(Schema.is(AppUpdate)({ ...update, downloadUrl })).toBe(false);
    expect(Schema.is(AppUpdate)({ ...update, sha256: "invalid" })).toBe(false);
  });
});
