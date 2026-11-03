import solarizedLight from "@shikijs/themes/solarized-light";
import solarizedDark from "@shikijs/themes/solarized-dark";
import githubLight from "@shikijs/themes/github-light";
import githubDark from "@shikijs/themes/github-dark";
import catppuccinLatte from "@shikijs/themes/catppuccin-latte";
import catppuccinMocha from "@shikijs/themes/catppuccin-mocha";
import rosePineDawn from "@shikijs/themes/rose-pine-dawn";
import rosePine from "@shikijs/themes/rose-pine";
import dracula from "@shikijs/themes/dracula";
import nord from "@shikijs/themes/nord";
import oneDarkPro from "@shikijs/themes/one-dark-pro";
import tokyoNight from "@shikijs/themes/tokyo-night";
import type {
  ColorScheme,
  ColorThemeChoice,
  EditorColorTheme,
  ImportedColorTheme,
} from "../contracts/themes/color-theme";
import { opaqueColorOver, parseVsCodeTheme } from "./vscode-theme";

export interface ColorThemeOption {
  readonly choice: ColorThemeChoice;
  readonly name: string;
  readonly type: ColorScheme;
  readonly theme: EditorColorTheme;
}

// The installed Shiki collection supplies the original workbench and syntax palettes.
// Normalize through the same color-data contract as imports; no extension code runs.
const popularThemes = [
  ["solarized-light", solarizedLight],
  ["solarized-dark", solarizedDark],
  ["github-light", githubLight],
  ["github-dark", githubDark],
  ["catppuccin-latte", catppuccinLatte],
  ["catppuccin-mocha", catppuccinMocha],
  ["rose-pine-dawn", rosePineDawn],
  ["rose-pine", rosePine],
  ["dracula", dracula],
  ["nord", nord],
  ["one-dark-pro", oneDarkPro],
  ["tokyo-night", tokyoNight],
] as const;
const popularColorData = popularThemes.map(([id, source]) =>
  withOpaqueInput(
    parseVsCodeTheme(
      "theme.json",
      new Map([["theme.json", JSON.stringify({ ...source, name: source.displayName })]]),
      id,
    ),
  ),
);

// Built-in composers stay solid; imported themes keep any authored input transparency.
function withOpaqueInput(theme: ImportedColorTheme): ImportedColorTheme {
  const input = theme.colors["input.background"];
  const editor = theme.colors["editor.background"];
  if (!input || !editor) return theme;
  return {
    ...theme,
    colors: { ...theme.colors, "input.background": opaqueColorOver(input, editor) },
  };
}

const macPalettes = [
  {
    id: "lifted-graphite",
    name: "Lifted macOS Graphite",
    background: "#1d2128",
    sidebar: "#161920",
    card: "#262b34",
    border: "#39414e",
  },
  {
    id: "macos-vibrancy",
    name: "macOS Vibrancy",
    background: "#1b2028",
    sidebar: "#222834",
    card: "#262b34",
    border: "#39414e",
  },
  {
    id: "soft-slate",
    name: "Soft Slate",
    background: "#242a34",
    sidebar: "#1c2129",
    card: "#2e3540",
    border: "#485160",
  },
  {
    id: "twilight-steel",
    name: "Twilight Steel",
    background: "#1c2430",
    sidebar: "#141b24",
    card: "#252f3d",
    border: "#39495d",
  },
  {
    id: "warm-titanium",
    name: "Warm Titanium",
    background: "#242321",
    sidebar: "#1d1c1a",
    card: "#2e2d2a",
    border: "#46443f",
  },
].map((palette) => ({
  id: palette.id,
  name: palette.name,
  type: "dark" as const,
  colors: {
    "editor.background": palette.background,
    "editor.foreground": "#e4e8ee",
    "sideBar.background": palette.sidebar,
    "sideBar.foreground": "#d1d5dc",
    "editorWidget.background": palette.card,
    "menu.background": palette.card,
    "input.background": palette.card,
    "input.foreground": "#e4e8ee",
    "panel.border": palette.border,
    "input.border": palette.border,
    "button.background": "#e4e8ee",
    "button.foreground": palette.background,
    focusBorder: "#0a84ff",
    "textLink.foreground": "#0a84ff",
    "list.activeSelectionBackground": palette.card,
    "list.activeSelectionForeground": "#e4e8ee",
    "editor.selectionBackground": "#0a84ff40",
  },
  tokenColors: githubDark.tokenColors ?? [],
  semanticTokenColors: {},
  semanticHighlighting: true,
}));

export const bundledColorThemes: readonly ColorThemeOption[] = [
  { choice: "bundled:cake-light", name: "Cake Light", type: "light", theme: "light" },
  { choice: "bundled:cake-dark", name: "Cake Dark", type: "dark", theme: "dark" },
  ...[...macPalettes, ...popularColorData].map((theme): ColorThemeOption => ({
    choice: `bundled:${theme.id}`,
    name: theme.name,
    type: theme.type,
    theme,
  })),
];
