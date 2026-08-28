#!/usr/bin/env node
/**
 * Generates the Cake color themes for the embedded VS Code editor from the
 * semantic tokens in src/renderer/styles.css. Output lands in
 * src/assets/vscode-companion/themes/ and is committed; rerun `pnpm theme:build`
 * (which also applies the repo formatter) whenever the app tokens change.
 *
 * Run: node scripts/generate-vscode-theme.mjs
 */

/* global console */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const stylesSource = readFileSync(resolve(repoRoot, "src/renderer/styles.css"), "utf8");
const outputDir = resolve(repoRoot, "src/assets/vscode-companion/themes");

// --- oklch -> sRGB -----------------------------------------------------------
// OKLab -> linear sRGB matrices are Björn Ottosson's (public domain).

function oklchToLinearSrgb(L, C, H) {
  const angle = (H * Math.PI) / 180;
  const a = C * Math.cos(angle);
  const b = C * Math.sin(angle);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ ** 3;
  const m = m_ ** 3;
  const s = s_ ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

function gamma(value) {
  const clamped = Math.min(1, Math.max(0, value));
  return clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * clamped ** (1 / 2.4) - 0.055;
}

function oklch(L, C, H) {
  return { L, C, H };
}

function hex(color, alpha = 1) {
  const [r, g, b] = oklchToLinearSrgb(color.L, color.C, color.H).map((channel) =>
    Math.round(gamma(channel) * 255),
  );
  const rgb = [r, g, b].map((channel) => channel.toString(16).padStart(2, "0")).join("");
  if (alpha >= 1) return `#${rgb}`;
  const a = Math.round(Math.min(1, Math.max(0, alpha)) * 255)
    .toString(16)
    .padStart(2, "0");
  return `#${rgb}${a}`;
}

/** Perceptual mix in OKLCh, following the shortest hue path. */
function mix(a, b, t) {
  const hueDelta = (((b.H - a.H + 540) % 360) - 180) * t;
  return oklch(a.L + (b.L - a.L) * t, a.C + (b.C - a.C) * t, (a.H + hueDelta + 360) % 360);
}

// --- token extraction --------------------------------------------------------

function tokenBlocks() {
  const blocks = [];
  const blockPattern = /([^{}]+)\{([^{}]*)\}/g;
  for (const [, selector, body] of stylesSource.matchAll(blockPattern)) {
    const tokens = {};
    for (const declaration of body.split(";")) {
      const pair = declaration.match(/--([a-z0-9-]+):\s*([^;]+)/);
      if (pair)
        tokens[pair[1].replace(/-([a-z])/g, (_, character) => character.toUpperCase())] =
          pair[2].trim();
    }
    blocks.push({ selector: selector.trim(), tokens });
  }
  return blocks;
}

function parseOklch(value) {
  const match = value.match(/oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)/);
  if (!match) throw new Error(`Unrecognized oklch token: ${value}`);
  return oklch(Number(match[1]), Number(match[2]), Number(match[3]));
}

function findTokens(attribute) {
  const block = tokenBlocks().find((candidate) =>
    candidate.selector.includes(`:root[data-theme="${attribute}"]`),
  );
  if (!block) throw new Error(`No :root[data-theme="${attribute}"] block found in styles.css`);
  const parsed = {};
  for (const [name, value] of Object.entries(block.tokens)) {
    if (value.startsWith("oklch(")) parsed[name] = parseOklch(value);
  }
  for (const required of [
    "background",
    "foreground",
    "card",
    "primary",
    "primaryForeground",
    "muted",
    "mutedForeground",
    "accent",
    "border",
    "ring",
    "sidebar",
    "sidebarHover",
    "sidebarActive",
    "composer",
  ])
    if (!parsed[required]) throw new Error(`Token --${required} is missing from the theme block`);
  const shadow = block.tokens.shadow?.match(/([\d.]+)\s+([\d.]+)%\s+([\d.]+)%/);
  if (shadow) {
    const hue = (Number(shadow[1]) % 360) / 360;
    const s = Number(shadow[2]) / 100;
    const l = Number(shadow[3]) / 100;
    const f = (n) => {
      const k = (n + hue * 12) % 12;
      const channel = l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
      return Math.round(channel * 255)
        .toString(16)
        .padStart(2, "0");
    };
    parsed.__shadowRgbaBase = `#${f(0)}${f(8)}${f(4)}`;
  }
  return parsed;
}

// --- derived palette ---------------------------------------------------------
// Cake's tokens describe UI surfaces, not syntax colors. These companions stay
// inside the app's cool-blue family (hue ~250) while giving keywords, strings,
// numbers, types, and functions distinguishable hues.

const palettes = {
  light: {
    red: oklch(0.55, 0.19, 25),
    redBright: oklch(0.62, 0.19, 25),
    orange: oklch(0.6, 0.14, 55),
    orangeBright: oklch(0.68, 0.14, 55),
    yellow: oklch(0.7, 0.14, 80),
    yellowBright: oklch(0.78, 0.14, 80),
    green: oklch(0.55, 0.12, 160),
    greenBright: oklch(0.62, 0.12, 160),
    cyan: oklch(0.55, 0.11, 210),
    cyanBright: oklch(0.62, 0.11, 210),
    blue: oklch(0.55, 0.16, 250),
    blueBright: oklch(0.62, 0.16, 250),
    violet: oklch(0.55, 0.15, 300),
    violetBright: oklch(0.62, 0.15, 300),
    magenta: oklch(0.55, 0.16, 320),
    magentaBright: oklch(0.62, 0.16, 320),
    black: oklch(0.3, 0.015, 250),
    blackBright: oklch(0.5, 0.018, 250),
    white: oklch(0.85, 0.008, 250),
    whiteBright: oklch(0.95, 0.005, 250),
  },
  dark: {
    red: oklch(0.68, 0.18, 25),
    redBright: oklch(0.76, 0.18, 25),
    orange: oklch(0.78, 0.13, 60),
    orangeBright: oklch(0.84, 0.13, 60),
    yellow: oklch(0.82, 0.13, 80),
    yellowBright: oklch(0.88, 0.13, 80),
    green: oklch(0.76, 0.12, 160),
    greenBright: oklch(0.82, 0.12, 160),
    cyan: oklch(0.78, 0.1, 210),
    cyanBright: oklch(0.84, 0.1, 210),
    blue: oklch(0.72, 0.14, 250),
    blueBright: oklch(0.8, 0.14, 250),
    violet: oklch(0.76, 0.13, 300),
    violetBright: oklch(0.82, 0.13, 300),
    magenta: oklch(0.7, 0.15, 320),
    magentaBright: oklch(0.78, 0.15, 320),
    black: oklch(0.45, 0.01, 250),
    blackBright: oklch(0.6, 0.015, 250),
    white: oklch(0.91, 0.008, 250),
    whiteBright: oklch(0.97, 0.004, 250),
  },
};

// --- theme assembly ----------------------------------------------------------

function buildTheme(kind, tokens, palette) {
  const t = tokens;
  const P = palette;
  const label = kind === "dark" ? "Cake Dark" : "Cake Light";
  const operatorColor = mix(t.foreground, t.mutedForeground, 0.5);
  const parameterColor = mix(t.foreground, t.mutedForeground, 0.3);
  const punctuationColor = mix(t.foreground, t.mutedForeground, 0.4);

  const colors = {
    // Editor surfaces
    "editor.background": hex(t.background),
    "editor.foreground": hex(t.foreground),
    "editorGutter.background": hex(t.background),
    "editorLineNumber.foreground": hex(mix(t.border, t.mutedForeground, 0.35)),
    "editorLineNumber.activeForeground": hex(t.mutedForeground),
    "editorCursor.foreground": hex(t.accent),
    "editor.selectionBackground": hex(t.accent, 0.28),
    "editor.inactiveSelectionBackground": hex(t.accent, 0.14),
    "editor.wordHighlightBackground": hex(t.accent, 0.1),
    "editor.wordHighlightStrongBackground": hex(t.accent, 0.18),
    "editor.rangeHighlightBackground": hex(t.accent, 0.12),
    "editor.lineHighlightBackground": hex(mix(t.background, t.muted, 0.55)),
    "editorWhitespace.foreground": hex(t.border),
    "editorIndentGuide.background1": hex(t.border),
    "editorIndentGuide.activeBackground1": hex(t.mutedForeground, 0.5),
    "editorBracketMatch.background": hex(t.accent, 0.14),
    "editorBracketMatch.border": hex(t.accent, 0.4),
    "editor.findMatchBackground": hex(t.accent, 0.35),
    "editor.findMatchHighlightBackground": hex(t.accent, 0.18),
    "editorError.foreground": hex(P.red),
    "editorWarning.foreground": hex(P.yellow),
    "editorInfo.foreground": hex(P.blue),
    "editorLightBulb.foreground": hex(P.yellow),
    "editorGhostText.foreground": hex(t.mutedForeground, 0.7),
    "editorInlayHint.foreground": hex(t.mutedForeground),
    "editorInlayHint.background": hex(t.muted, 0.55),
    "editorCodeLens.foreground": hex(t.mutedForeground, 0.7),
    "editorRuler.foreground": hex(t.border),
    "editorLink.activeForeground": hex(t.accent),
    "editorUnnecessaryCode.opacity": "#00000099",
    "editorHoverWidget.background": hex(t.card),
    "editorHoverWidget.border": hex(t.border),
    "editorSuggestWidget.background": hex(t.card),
    "editorSuggestWidget.border": hex(t.border),
    "editorSuggestWidget.selectedBackground": hex(t.sidebarActive),
    "editorWidget.background": hex(t.card),
    "editorWidget.border": hex(t.border),
    "editorOverviewRuler.border": hex(t.border, 0.5),
    "editorOverviewRuler.addedForeground": hex(P.green, 0.8),
    "editorOverviewRuler.modifiedForeground": hex(P.yellow, 0.8),
    "editorOverviewRuler.deletedForeground": hex(P.red, 0.8),
    "minimap.background": hex(t.background),
    "minimapSlider.background": hex(t.mutedForeground, 0.2),
    "minimapSlider.hoverBackground": hex(t.mutedForeground, 0.35),
    "minimapSlider.activeBackground": hex(t.mutedForeground, 0.5),
    "scrollbar.shadow": `${t.__shadowRgbaBase}${kind === "dark" ? "40" : "1a"}`,
    "scrollbarSlider.background": hex(t.mutedForeground, 0.2),
    "scrollbarSlider.hoverBackground": hex(t.mutedForeground, 0.3),
    "scrollbarSlider.activeBackground": hex(t.mutedForeground, 0.4),
    "diffEditor.insertedTextBackground": hex(P.green, 0.16),
    "diffEditor.removedTextBackground": hex(P.red, 0.16),
    "diffEditor.border": hex(t.border),

    // Chrome and inputs
    focusBorder: hex(t.ring, 0.55),
    foreground: hex(t.foreground),
    descriptionForeground: hex(t.mutedForeground),
    errorForeground: hex(P.red),
    border: hex(t.border),
    "selection.background": hex(t.accent, 0.28),
    "sash.hoverBorder": hex(t.accent, 0.6),
    "button.background": hex(t.primary),
    "button.foreground": hex(t.primaryForeground),
    "button.hoverBackground": hex(mix(t.primary, t.foreground, 0.12)),
    "button.secondaryBackground": hex(t.muted),
    "button.secondaryForeground": hex(t.foreground),
    "button.secondaryHoverBackground": hex(mix(t.muted, t.foreground, 0.08)),
    "checkbox.background": hex(t.composer),
    "checkbox.border": hex(t.border),
    "dropdown.background": hex(t.card),
    "dropdown.foreground": hex(t.foreground),
    "dropdown.border": hex(t.border),
    "input.background": hex(t.composer),
    "input.foreground": hex(t.foreground),
    "input.border": hex(t.border),
    "input.placeholderForeground": hex(t.mutedForeground, 0.7),
    "inputOption.activeBorder": hex(t.accent),
    "inputValidation.errorBackground": hex(mix(t.background, P.red, 0.12)),
    "inputValidation.errorBorder": hex(P.red),
    "inputValidation.warningBackground": hex(mix(t.background, P.yellow, 0.12)),
    "inputValidation.warningBorder": hex(P.yellow),
    "inputValidation.infoBackground": hex(mix(t.background, P.blue, 0.12)),
    "inputValidation.infoBorder": hex(P.blue),
    "badge.background": hex(t.accent),
    "badge.foreground": "#ffffff",
    "progressBar.background": hex(t.accent),

    // Lists, trees, and side bars
    "list.activeSelectionBackground": hex(t.sidebarActive),
    "list.activeSelectionForeground": hex(t.foreground),
    "list.inactiveSelectionBackground": hex(t.sidebarHover, 0.5),
    "list.hoverBackground": hex(t.sidebarHover),
    "list.focusOutline": hex(t.ring, 0.5),
    "list.highlightForeground": hex(t.accent),
    "listFilterWidget.background": hex(t.muted),
    "listFilterWidget.outline": hex(t.border),
    "listFilterWidget.noMatchesOutline": hex(P.red),
    "tree.indentGuidesStroke": hex(t.border),
    "activityBar.background": hex(t.sidebar),
    "activityBar.foreground": hex(t.foreground),
    "activityBar.inactiveForeground": hex(t.mutedForeground),
    "activityBar.border": hex(t.border),
    "activityBarBadge.background": hex(t.accent),
    "activityBarBadge.foreground": "#ffffff",
    "sideBar.background": hex(t.sidebar),
    "sideBar.foreground": hex(t.foreground),
    "sideBar.border": hex(t.border),
    "sideBarTitle.foreground": hex(t.foreground),
    "sideBarSectionHeader.background": hex(t.sidebar),
    "sideBarSectionHeader.border": hex(t.border),

    // Status bar and title bar
    "statusBar.background": hex(t.card),
    "statusBar.foreground": hex(t.mutedForeground),
    "statusBar.border": hex(t.border),
    "statusBar.debuggingBackground": hex(P.magenta),
    "statusBar.debuggingForeground": "#ffffff",
    "statusBarItem.remoteBackground": hex(t.accent),
    "statusBarItem.remoteForeground": "#ffffff",
    "statusBarItem.prominentBackground": hex(t.primary),
    "statusBarItem.prominentForeground": hex(t.primaryForeground),
    "statusBarItem.hoverBackground": hex(t.sidebarHover),
    "titleBar.activeBackground": hex(t.card),
    "titleBar.activeForeground": hex(t.foreground),
    "titleBar.inactiveBackground": hex(t.background),
    "titleBar.inactiveForeground": hex(t.mutedForeground),
    "titleBar.border": hex(t.border),

    // Menus, notifications, and quick input
    "menu.background": hex(t.card),
    "menu.foreground": hex(t.foreground),
    "menu.border": hex(t.border),
    "menu.selectionBackground": hex(t.sidebarActive),
    "menu.selectionForeground": hex(t.foreground),
    "menu.separatorBackground": hex(t.border),
    "notificationCenterHeader.background": hex(t.card),
    "notifications.background": hex(t.card),
    "notifications.foreground": hex(t.foreground),
    "notifications.border": hex(t.border),
    "notificationToast.border": hex(t.border),
    "notificationLink.foreground": hex(t.accent),
    "notificationsErrorIcon.foreground": hex(P.red),
    "notificationsWarningIcon.foreground": hex(P.yellow),
    "notificationsInfoIcon.foreground": hex(P.blue),
    "quickInput.background": hex(t.card),
    "quickInput.foreground": hex(t.foreground),
    "quickInputList.focusBackground": hex(t.sidebarActive),
    "pickerGroup.border": hex(t.border),
    "pickerGroup.foreground": hex(t.accent),

    // Tabs, breadcrumbs, and panel
    "editorGroupHeader.tabsBackground": hex(t.background),
    "editorGroup.border": hex(t.border),
    "tab.activeBackground": hex(t.background),
    "tab.activeForeground": hex(t.foreground),
    "tab.inactiveBackground": hex(t.background),
    "tab.inactiveForeground": hex(t.mutedForeground),
    "tab.border": hex(t.border),
    "tab.activeBorderTop": hex(t.accent),
    "tab.hoverBackground": hex(t.sidebarHover, 0.4),
    "tab.unfocusedActiveBorderTop": hex(t.accent, 0.4),
    "breadcrumb.foreground": hex(t.mutedForeground),
    "breadcrumb.background": hex(t.background),
    "breadcrumb.focusForeground": hex(t.foreground),
    "breadcrumbPicker.background": hex(t.card),
    "panel.background": hex(t.background),
    "panel.border": hex(t.border),
    "panelTitle.activeForeground": hex(t.foreground),
    "panelTitle.inactiveForeground": hex(t.mutedForeground),
    "panelInput.border": hex(t.border),
    "peekView.border": hex(t.accent, 0.5),
    "peekViewEditor.background": hex(t.card),
    "peekViewResult.background": hex(t.sidebar),
    "peekViewResult.selectionBackground": hex(t.sidebarActive),
    "peekViewTitle.background": hex(t.sidebar),

    // Terminal
    "terminal.background": hex(t.background),
    "terminal.foreground": hex(t.foreground),
    "terminal.border": hex(t.border),
    "terminalCursor.foreground": hex(t.accent),
    "terminal.selectionBackground": hex(t.accent, 0.25),
    "terminal.tab.activeBorder": hex(t.accent),
    "terminal.ansiBlack": hex(P.black),
    "terminal.ansiRed": hex(P.red),
    "terminal.ansiGreen": hex(P.green),
    "terminal.ansiYellow": hex(P.yellow),
    "terminal.ansiBlue": hex(P.blue),
    "terminal.ansiMagenta": hex(P.magenta),
    "terminal.ansiCyan": hex(P.cyan),
    "terminal.ansiWhite": hex(P.white),
    "terminal.ansiBrightBlack": hex(P.blackBright),
    "terminal.ansiBrightRed": hex(P.redBright),
    "terminal.ansiBrightGreen": hex(P.greenBright),
    "terminal.ansiBrightYellow": hex(P.yellowBright),
    "terminal.ansiBrightBlue": hex(P.blueBright),
    "terminal.ansiBrightMagenta": hex(P.magentaBright),
    "terminal.ansiBrightCyan": hex(P.cyanBright),
    "terminal.ansiBrightWhite": hex(P.whiteBright),

    // Text, links, git, merge, and debug
    "textLink.foreground": hex(t.accent),
    "textBlockQuote.background": hex(t.card),
    "textBlockQuote.border": hex(t.border),
    "textCodeBlock.background": hex(t.card),
    "textSeparator.foreground": hex(t.border),
    "gitDecoration.addedResourceForeground": hex(P.green),
    "gitDecoration.modifiedResourceForeground": hex(P.yellow),
    "gitDecoration.deletedResourceForeground": hex(P.red),
    "gitDecoration.renamedResourceForeground": hex(P.cyan),
    "gitDecoration.untrackedResourceForeground": hex(P.blue),
    "gitDecoration.conflictingResourceForeground": hex(P.magenta),
    "gitDecoration.ignoredResourceForeground": hex(t.mutedForeground, 0.6),
    "merge.currentHeaderBackground": hex(P.blue, 0.2),
    "merge.incomingHeaderBackground": hex(P.cyan, 0.2),
    "debugToolBar.background": hex(t.card),
  };

  const tokenColors = [
    { scope: ["comment"], settings: { foreground: hex(t.mutedForeground), fontStyle: "italic" } },
    { scope: ["string"], settings: { foreground: hex(P.green) } },
    { scope: ["string.regexp"], settings: { foreground: hex(P.orange) } },
    { scope: ["constant.numeric"], settings: { foreground: hex(P.orange) } },
    { scope: ["constant.language"], settings: { foreground: hex(P.blue) } },
    { scope: ["keyword"], settings: { foreground: hex(P.blue) } },
    { scope: ["keyword.operator"], settings: { foreground: hex(operatorColor) } },
    { scope: ["storage"], settings: { foreground: hex(P.blue) } },
    {
      scope: ["entity.name.function", "support.function"],
      settings: { foreground: hex(P.violet) },
    },
    {
      scope: [
        "entity.name.type",
        "entity.name.class",
        "entity.name.interface",
        "entity.name.enum",
        "support.type",
        "support.class",
      ],
      settings: { foreground: hex(P.cyan) },
    },
    { scope: ["entity.name.tag"], settings: { foreground: hex(P.blue) } },
    { scope: ["entity.other.attribute-name"], settings: { foreground: hex(P.violet) } },
    { scope: ["variable"], settings: { foreground: hex(t.foreground) } },
    { scope: ["variable.parameter"], settings: { foreground: hex(parameterColor) } },
    {
      scope: ["variable.other.property", "support.variable.property"],
      settings: { foreground: hex(t.foreground) },
    },
    { scope: ["meta.object-literal.key"], settings: { foreground: hex(parameterColor) } },
    {
      scope: ["support.type.property-name.json"],
      settings: { foreground: hex(P.violet) },
    },
    { scope: ["punctuation"], settings: { foreground: hex(punctuationColor) } },
    {
      scope: ["markup.heading", "entity.name.section"],
      settings: { foreground: hex(P.blue), fontStyle: "bold" },
    },
    { scope: ["markup.bold"], settings: { fontStyle: "bold" } },
    { scope: ["markup.italic"], settings: { fontStyle: "italic" } },
    { scope: ["markup.inline.raw"], settings: { foreground: hex(P.violet) } },
    { scope: ["markup.inserted"], settings: { foreground: hex(P.green) } },
    { scope: ["markup.deleted"], settings: { foreground: hex(P.red) } },
    { scope: ["markup.changed"], settings: { foreground: hex(P.yellow) } },
  ];

  const semanticTokenColors = {
    comment: hex(t.mutedForeground),
    string: hex(P.green),
    number: hex(P.orange),
    keyword: hex(P.blue),
    operator: hex(operatorColor),
    function: hex(P.violet),
    method: hex(P.violet),
    macro: hex(P.violet),
    decorator: hex(P.violet),
    namespace: hex(P.violet),
    class: hex(P.cyan),
    interface: hex(P.cyan),
    enum: hex(P.cyan),
    type: hex(P.cyan),
    typeParameter: hex(P.cyan),
    struct: hex(P.cyan),
    variable: hex(t.foreground),
    parameter: hex(parameterColor),
    property: hex(t.foreground),
    enumMember: hex(P.orange),
    "variable.readonly": hex(P.orange),
    event: hex(P.yellow),
  };

  return {
    name: label,
    type: kind,
    semanticHighlighting: true,
    colors,
    tokenColors,
    semanticTokenColors,
  };
}

// --- output ------------------------------------------------------------------

mkdirSync(outputDir, { recursive: true });
for (const kind of ["light", "dark"]) {
  const theme = buildTheme(kind, findTokens(kind), palettes[kind]);
  const target = resolve(outputDir, `cake-${kind}-color-theme.json`);
  writeFileSync(target, `${JSON.stringify(theme, null, 2)}\n`);
  console.log(`Wrote ${target}`);
}
