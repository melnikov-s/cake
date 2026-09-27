import { describe, expect, it } from "vitest";
import { extensionCompanionModuleUrl } from "../../../src/renderer/lib/extension-companion-module-url";

const token = "a".repeat(64);
const published = `cake-extension://module/${token}`;

describe("extensionCompanionModuleUrl", () => {
  it("maps only an exact published capability to the browser origin", () => {
    const browser = { protocol: "https:", origin: "https://cake.example:1234" };
    expect(extensionCompanionModuleUrl(published, browser)).toBe(
      `https://cake.example:1234/widget-assets/module/${token}`,
    );
    for (const invalid of [
      "https://evil.example/module.js",
      "/widget-assets/module/" + token,
      `cake-extension://module/${token}?x=1`,
      `cake-extension://module/${token}#fragment`,
      `cake-extension://module/${token}/other`,
      `cake-extension://other/${token}`,
      `cake-extension://module/${token.toUpperCase()}`,
      "cake-extension://module/short",
    ]) {
      expect(extensionCompanionModuleUrl(invalid, browser)).toBeUndefined();
    }
  });

  it("keeps the validated native protocol URL intact", () => {
    expect(extensionCompanionModuleUrl(published, { protocol: "file:", origin: "null" })).toBe(
      published,
    );
  });
});
