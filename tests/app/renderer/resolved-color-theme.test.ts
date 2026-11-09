/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import { applyDocumentTheme } from "../../../src/renderer/lib/resolved-color-theme";
import { bundledColorThemes } from "../../../src/utils/bundled-color-themes";
import { cakeThemeTokens, parseVsCodeTheme } from "../../../src/utils/vscode-theme";

afterEach(() => applyDocumentTheme("system"));

describe("document worktree status colors", () => {
  it("clears stale overrides and leaves CSS in control across imported, bundled and default themes", () => {
    const imported = parseVsCodeTheme(
      "theme.json",
      new Map([
        [
          "theme.json",
          JSON.stringify({
            type: "light",
            colors: {
              "editor.background": "#faf4e8",
              "gitDecoration.addedResourceForeground": "#ff0000",
              "gitDecoration.stageModifiedResourceForeground": "#ebcb8b",
            },
          }),
        ],
      ]),
      "test",
    );
    const root = document.documentElement;
    for (const theme of [imported, ...bundledColorThemes.map((option) => option.theme)]) {
      // Simulate overrides left by the previous theme implementation.
      root.style.setProperty("--worktree-open", "#ff0000");
      root.style.setProperty("--worktree-merged", "#ebcb8b");
      if (typeof theme === "string") applyDocumentTheme(theme);
      else applyDocumentTheme(theme.type, theme);
      expect(root.style.getPropertyValue("--worktree-open")).toBe("");
      expect(root.style.getPropertyValue("--worktree-merged")).toBe("");
      expect(root.dataset.theme).toBe(typeof theme === "string" ? theme : theme.type);
      expect(root.style.getPropertyValue("--background")).toBe(
        typeof theme === "string" ? "" : theme.colors["editor.background"],
      );
      expect(root.style.getPropertyValue("--sidebar")).toBe(
        typeof theme === "string" ? "" : cakeThemeTokens(theme)["--sidebar"],
      );
    }
    applyDocumentTheme("system");
    expect(root.dataset.theme).toBe("system");
    expect(root.style.getPropertyValue("--worktree-open")).toBe("");
    expect(root.style.getPropertyValue("--worktree-merged")).toBe("");
    expect(root.style.getPropertyValue("--background")).toBe("");
  });
});
