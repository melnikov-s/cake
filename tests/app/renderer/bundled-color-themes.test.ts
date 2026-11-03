import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { ImportedColorTheme, editorThemeSettings } from "../../../src/contracts/themes/color-theme";
import { bundledColorThemes } from "../../../src/utils/bundled-color-themes";
import { cakeThemeTokens, contrastRatio } from "../../../src/utils/vscode-theme";

describe("bundled Cake theme collection", () => {
  it("ships distinct light/dark choices using the same color-data contract as imports", () => {
    expect(new Set(bundledColorThemes.map((theme) => theme.choice)).size).toBe(
      bundledColorThemes.length,
    );
    for (const name of [
      "Solarized Light",
      "Solarized Dark",
      "GitHub Light",
      "GitHub Dark",
      "Catppuccin Latte",
      "Catppuccin Mocha",
      "Nord",
      "One Dark Pro",
      "Tokyo Night",
    ]) {
      expect(bundledColorThemes.some((theme) => theme.name === name)).toBe(true);
    }
    for (const option of bundledColorThemes) {
      const theme = option.theme;
      if (theme === "light" || theme === "dark") continue;
      expect(() => Schema.decodeUnknownSync(ImportedColorTheme)(theme)).not.toThrow();
      expect(theme.type).toBe(option.type);
      expect(theme.tokenColors.length).toBeGreaterThan(0);
      expect(editorThemeSettings(theme)["workbench.colorCustomizations"]).toBe(theme.colors);
      expect(cakeThemeTokens(theme)["--background"]).toBe(theme.colors["editor.background"]);
    }
  });

  it("gives every built-in theme a solid composer and a visible accent", () => {
    for (const { theme } of bundledColorThemes) {
      if (theme === "light" || theme === "dark") continue;
      const tokens = cakeThemeTokens(theme);
      expect(tokens["--composer"], theme.id).toMatch(/^#([\da-f]{3}|[\da-f]{6})$/i);
      for (const surface of ["--sidebar", "--background"] as const)
        expect(
          contrastRatio(tokens["--accent"]!, tokens[surface]!),
          `${theme.id} ${surface}`,
        ).toBeGreaterThanOrEqual(3);
    }
  });

  it("flattens Rosé Pine's translucent input over its editor background", () => {
    const theme = bundledColorThemes.find(({ choice }) => choice === "bundled:rose-pine")?.theme;
    if (!theme || typeof theme === "string") throw new Error("Missing Rosé Pine");
    // Upstream input.background is #26233a80 on #191724.
    expect(cakeThemeTokens(theme)["--composer"]).toBe("#201d2f");
  });

  it.each([
    ["lifted-graphite", "#1d2128", "#161920", "#262b34"],
    ["macos-vibrancy", "#1b2028", "#222834", "#262b34"],
    ["soft-slate", "#242a34", "#1c2129", "#2e3540"],
    ["twilight-steel", "#1c2430", "#141b24", "#252f3d"],
    ["warm-titanium", "#242321", "#1d1c1a", "#2e2d2a"],
  ])(
    "preserves the supplied %s surface hierarchy and macOS blue accent",
    (id, background, sidebar, card) => {
      const theme = bundledColorThemes.find((theme) => theme.choice === `bundled:${id}`)?.theme;
      if (!theme || typeof theme === "string") throw new Error(`Missing custom palette: ${id}`);
      expect(cakeThemeTokens(theme)).toMatchObject({
        "--background": background,
        "--sidebar": sidebar,
        "--card": card,
        "--popover": card,
        "--composer": card,
        "--accent": "#0a84ff",
      });
    },
  );
});
