import { describe, expect, it } from "vitest";
import { shouldAllowNavigation } from "../../../src/main/navigation-policy";

describe("Electron navigation policy", () => {
  it("allows a Vite full-page reload of the current renderer", () => {
    expect(shouldAllowNavigation("http://localhost:5174/", "http://localhost:5174/", "http://localhost:5174")).toBe(true);
  });

  it("allows same-origin dev-server navigation when Vite changes the URL", () => {
    expect(shouldAllowNavigation("http://localhost:5174/", "http://localhost:5174/?updated=1", "http://localhost:5174")).toBe(true);
  });

  it("continues to block external and malformed navigation", () => {
    expect(shouldAllowNavigation("http://localhost:5174/", "https://example.com/", "http://localhost:5174")).toBe(false);
    expect(shouldAllowNavigation("file:///app/index.html", "not a URL")).toBe(false);
  });
});
