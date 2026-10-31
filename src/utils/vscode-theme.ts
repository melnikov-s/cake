import { Option, Schema } from "effect";
import { parse, type ParseError } from "jsonc-parser";
import { VsCodeThemeSource, type ImportedColorTheme } from "../contracts/themes/color-theme";

function sourcePath(path: string) {
  const parts: string[] = [];
  for (const part of path.replaceAll("\\", "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!parts.length) throw new Error("Theme include is outside the selected source.");
      parts.pop();
    } else parts.push(part);
  }
  return parts.join("/");
}

export function parseVsCodeTheme(
  entry: string,
  files: ReadonlyMap<string, string>,
  id: string,
): ImportedColorTheme {
  const visiting = new Set<string>();
  function load(path: string): ImportedColorTheme {
    path = sourcePath(path);
    if (visiting.has(path)) throw new Error(`Circular theme include: ${path}`);
    const text = files.get(path);
    if (text === undefined)
      throw new Error(`Missing include: ${path}. Import its containing folder.`);
    const errors: ParseError[] = [];
    const raw: unknown = parse(text, errors, { allowTrailingComma: true });
    if (errors.length) throw new Error(`Invalid JSON/JSONC in ${path}.`);
    const decoded = Schema.decodeUnknownOption(VsCodeThemeSource)(raw);
    if (Option.isNone(decoded))
      throw new Error(
        `Invalid VS Code color theme: ${path}. Expected hex colors and tokenColors rules (not a .tmTheme path).`,
      );
    const data = decoded.value;
    if (!data.include && !data.colors && !data.tokenColors && !data.semanticTokenColors)
      throw new Error(
        `No theme color data in ${path}. Choose a color-theme JSON file, not package.json.`,
      );
    visiting.add(path);
    const base = data.include
      ? load(sourcePath(`${path.slice(0, path.lastIndexOf("/") + 1)}${data.include}`))
      : undefined;
    visiting.delete(path);
    const colors = { ...base?.colors };
    for (const [key, value] of Object.entries(data.colors ?? {})) {
      if (value === null) delete colors[key];
      else colors[key] = value;
    }
    const background = colors["editor.background"];
    const inferred = background && colorLightness(background) > 0.5 ? "light" : "dark";
    return {
      id,
      name:
        data.name?.trim() ||
        path
          .split("/")
          .pop()
          ?.replace(/\.jsonc?$/i, "") ||
        "Imported theme",
      type: data.type
        ? data.type === "light" || data.type === "hcLight"
          ? "light"
          : "dark"
        : (base?.type ?? inferred),
      colors,
      tokenColors: [...(base?.tokenColors ?? []), ...(data.tokenColors ?? [])],
      semanticTokenColors: { ...base?.semanticTokenColors, ...data.semanticTokenColors },
      semanticHighlighting: data.semanticHighlighting ?? base?.semanticHighlighting ?? true,
    };
  }
  return load(entry);
}

function colorLightness(hex: string) {
  const value =
    hex.length <= 5
      ? hex
          .slice(1, 4)
          .split("")
          .map((c) => c + c)
          .join("")
      : hex.slice(1, 7);
  const channels = [0, 2, 4].map((offset) => parseInt(value.slice(offset, offset + 2), 16) / 255);
  return 0.2126 * (channels[0] ?? 0) + 0.7152 * (channels[1] ?? 0) + 0.0722 * (channels[2] ?? 0);
}

/** Missing roles use the existing light/dark CSS defaults; derived roles follow imported surfaces. */
type CakeThemeTokens = Record<`--${string}`, string>;

export function cakeThemeTokens(theme: ImportedColorTheme) {
  const c = theme.colors;
  const tokens: CakeThemeTokens = {};
  const roles = {
    background: ["editor.background"],
    foreground: ["editor.foreground", "foreground"],
    card: ["editorWidget.background", "editor.background"],
    "card-foreground": ["editorWidget.foreground", "editor.foreground", "foreground"],
    popover: ["menu.background", "editorWidget.background", "editor.background"],
    "popover-foreground": ["menu.foreground", "editor.foreground", "foreground"],
    primary: ["button.background"],
    "primary-foreground": ["button.foreground"],
    secondary: ["button.secondaryBackground", "sideBar.background"],
    "secondary-foreground": ["button.secondaryForeground", "editor.foreground", "foreground"],
    muted: ["input.background", "sideBar.background"],
    "muted-foreground": ["descriptionForeground"],
    accent: ["focusBorder", "textLink.foreground", "button.background"],
    "accent-foreground": ["button.foreground"],
    ring: ["focusBorder"],
    border: ["panel.border", "widget.border", "sideBar.border"],
    input: ["input.border", "panel.border"],
    sidebar: ["sideBar.background", "editor.background"],
    "sidebar-foreground": ["sideBar.foreground", "foreground", "editor.foreground"],
    "sidebar-hover": ["list.hoverBackground"],
    "sidebar-active": ["list.activeSelectionBackground", "list.inactiveSelectionBackground"],
    "sidebar-selection-foreground": ["list.activeSelectionForeground"],
    composer: ["input.background", "editor.background"],
    "composer-foreground": ["input.foreground", "editor.foreground", "foreground"],
    success: ["testing.iconPassed", "gitDecoration.addedResourceForeground"],
    attention: ["editorWarning.foreground"],
    warning: ["editorWarning.foreground"],
    destructive: ["errorForeground", "editorError.foreground"],
    "worktree-open": ["gitDecoration.addedResourceForeground"],
    "worktree-merged": ["gitDecoration.stageModifiedResourceForeground"],
    selection: ["editor.selectionBackground"],
  };
  for (const [role, keys] of Object.entries(roles)) {
    const value = keys.map((key) => c[key]).find(Boolean);
    if (value) tokens[`--${role}`] = value;
  }
  const bg = c["editor.background"] ?? (theme.type === "dark" ? "#1e1e1e" : "#ffffff");
  const fg =
    c["editor.foreground"] ?? c.foreground ?? (theme.type === "dark" ? "#d4d4d4" : "#333333");
  tokens["--background"] = bg;
  tokens["--foreground"] = fg;
  tokens["--card"] ??= bg;
  tokens["--card-foreground"] ??= fg;
  tokens["--popover"] ??= bg;
  tokens["--popover-foreground"] ??= fg;
  tokens["--sidebar"] ??= bg;
  tokens["--sidebar-foreground"] ??= fg;
  tokens["--composer"] ??= bg;
  tokens["--composer-foreground"] ??= fg;
  tokens["--primary"] ??= fg;
  tokens["--primary-foreground"] ??= c["button.background"]
    ? colorLightness(c["button.background"]) > 0.5
      ? "#111111"
      : "#ffffff"
    : bg;
  tokens["--secondary"] ??= `color-mix(in srgb, ${fg} 9%, ${bg})`;
  tokens["--secondary-foreground"] ??= fg;
  tokens["--muted"] ??= tokens["--secondary"];
  tokens["--border"] ??= `color-mix(in srgb, ${fg} 20%, ${bg})`;
  tokens["--input"] ??= tokens["--border"];
  tokens["--sidebar-selection-foreground"] ??= c["list.activeSelectionBackground"]
    ? colorLightness(c["list.activeSelectionBackground"]) > 0.5
      ? "#111111"
      : "#ffffff"
    : fg;
  // A quiet tint of the theme foreground keeps chat distinct without borrowing a possibly translucent selection.
  tokens["--user-message"] = `color-mix(in srgb, ${fg} 9%, ${bg})`;
  tokens["--user-message-foreground"] = fg;
  tokens["--muted-foreground"] ??= `color-mix(in srgb, ${fg} 72%, ${bg})`;
  tokens["--sidebar-hover"] ??= `color-mix(in srgb, ${fg} 7%, var(--sidebar))`;
  tokens["--sidebar-active"] ??= `color-mix(in srgb, ${fg} 13%, var(--sidebar))`;
  return tokens;
}
