import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { ImportedColorTheme, editorThemeSettings } from "../../../src/contracts/themes/color-theme";
import { bundledColorThemes } from "../../../src/utils/bundled-color-themes";
import { cakeThemeTokens, contrastRatio } from "../../../src/utils/vscode-theme";
import { cakeColorPalettes } from "../../../src/utils/cake-color-palettes";

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

  it("ships seven coordinated palettes with distinct canvases and accents", () => {
    expect(cakeColorPalettes.map(({ name }) => name)).toEqual([
      "Hearth",
      "Moss",
      "Tidal",
      "Mulberry",
      "Fogbank",
      "Dune",
      "Letterpress",
    ]);
    for (const key of ["editor.background", "focusBorder"]) {
      expect(new Set(cakeColorPalettes.map(({ colors }) => colors[key])).size).toBe(7);
    }
    expect(cakeColorPalettes.filter(({ type }) => type === "dark")).toHaveLength(6);
    for (const theme of cakeColorPalettes) {
      expect(bundledColorThemes.find(({ choice }) => choice === `bundled:${theme.id}`)?.theme).toBe(
        theme,
      );
      const c = theme.colors;
      const tokens = cakeThemeTokens(theme);
      // Normal and supporting text remain readable on every surface they can occupy.
      for (const surface of [
        "editor.background",
        "sideBar.background",
        "editorWidget.background",
        "list.activeSelectionBackground",
      ]) {
        expect(
          contrastRatio(c["editor.foreground"]!, c[surface]!),
          `${theme.id} text on ${surface}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
      for (const surface of [
        "editor.background",
        "sideBar.background",
        "editorWidget.background",
      ]) {
        expect(
          contrastRatio(c.descriptionForeground!, c[surface]!),
          `${theme.id} metadata on ${surface}`,
        ).toBeGreaterThanOrEqual(4.5);
        for (const role of ["--success", "--warning", "--destructive", "--accent"] as const) {
          expect(
            contrastRatio(tokens[role]!, c[surface]!),
            `${theme.id} ${role} on ${surface}`,
          ).toBeGreaterThanOrEqual(3);
        }
      }
      expect(
        contrastRatio(tokens["--primary"]!, tokens["--primary-foreground"]!),
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        contrastRatio(tokens["--accent"]!, tokens["--accent-foreground"]!),
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        contrastRatio(tokens["--destructive"]!, tokens["--destructive-foreground"]!),
        `${theme.id} destructive action label`,
      ).toBeGreaterThanOrEqual(4.5);
      expect(c["editor.selectionBackground"]).not.toBe(c["editor.background"]);
      expect(
        new Set([
          tokens["--success"],
          tokens["--warning"],
          tokens["--destructive"],
          c["editorInfo.foreground"],
        ]).size,
      ).toBe(4);
      for (const rule of theme.tokenColors) {
        if (rule.settings.foreground)
          expect(
            contrastRatio(rule.settings.foreground, c["editor.background"]!),
            `${theme.id} syntax ${rule.scope}`,
          ).toBeGreaterThanOrEqual(4.5);
      }
      for (const name of ["Red", "Green", "Yellow", "Blue", "Magenta", "Cyan"]) {
        for (const variant of ["", "Bright"]) {
          expect(
            contrastRatio(c[`terminal.ansi${variant}${name}`]!, c["terminal.background"]!),
            `${theme.id} terminal ${variant}${name}`,
          ).toBeGreaterThanOrEqual(4.5);
        }
      }
      expect(c["terminal.background"]).toBe(tokens["--background"]);
      expect(c["terminal.foreground"]).toBe(tokens["--foreground"]);
      expect(theme.semanticTokenColors.function).toBe(c["terminal.ansiBlue"]);
      expect(tokens["--composer"]).toBe(c["input.background"]);
      expect(tokens["--ring"]).toBe(c.focusBorder);
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
