import { Schema } from "effect";

const ThemeColor = Schema.String.check(
  Schema.isPattern(/^#[\da-f]{3,4}$|^#[\da-f]{6}([\da-f]{2})?$/i),
);
const TokenColorRule = Schema.Struct({
  name: Schema.optionalKey(Schema.String),
  scope: Schema.optionalKey(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
  settings: Schema.Struct({
    foreground: Schema.optionalKey(ThemeColor),
    background: Schema.optionalKey(ThemeColor),
    fontStyle: Schema.optionalKey(Schema.String),
  }),
});
const semanticSettings = Schema.Struct({
  fontStyle: Schema.optionalKey(Schema.String),
  foreground: Schema.optionalKey(ThemeColor),
  bold: Schema.optionalKey(Schema.Boolean),
  italic: Schema.optionalKey(Schema.Boolean),
  underline: Schema.optionalKey(Schema.Boolean),
  strikethrough: Schema.optionalKey(Schema.Boolean),
});
const ThemeColors = Schema.Record(Schema.String, ThemeColor);
const ThemeData = Schema.Struct({
  colors: ThemeColors,
  tokenColors: Schema.Array(TokenColorRule),
  semanticTokenColors: Schema.Record(Schema.String, Schema.Union([ThemeColor, semanticSettings])),
  semanticHighlighting: Schema.Boolean,
});
export const ImportedColorTheme = Schema.Struct({
  ...ThemeData.fields,
  id: Schema.NonEmptyString,
  name: Schema.NonEmptyString,
  type: Schema.Literals(["light", "dark"]),
});
export interface ImportedColorTheme extends Schema.Schema.Type<typeof ImportedColorTheme> {}
export type EditorColorTheme = "light" | "dark" | ImportedColorTheme;
export type ColorScheme = "light" | "dark";
export const AppearanceMode = Schema.Literals(["system", "light", "dark"]);
export type AppearanceMode = Schema.Schema.Type<typeof AppearanceMode>;
export const ColorThemeChoice = Schema.Union([
  Schema.TemplateLiteral(["bundled:", Schema.NonEmptyString]),
  Schema.TemplateLiteral(["imported:", Schema.NonEmptyString]),
]);
export type ColorThemeChoice = Schema.Schema.Type<typeof ColorThemeChoice>;

/** The source may have comments/trailing commas; includes are resolved only in the chosen file set. */
export const VsCodeThemeSource = Schema.Struct({
  name: Schema.optionalKey(Schema.String),
  type: Schema.optionalKey(Schema.Literals(["light", "dark", "hc", "hcLight"])),
  include: Schema.optionalKey(Schema.String),
  colors: Schema.optionalKey(Schema.Record(Schema.String, Schema.NullOr(ThemeColor))),
  tokenColors: Schema.optionalKey(Schema.Array(TokenColorRule)),
  semanticTokenColors: Schema.optionalKey(ThemeData.fields.semanticTokenColors),
  semanticHighlighting: Schema.optionalKey(Schema.Boolean),
});

export function editorThemeSettings(theme: EditorColorTheme) {
  const custom = theme !== "light" && theme !== "dark" ? theme : undefined;
  const type = custom?.type ?? theme;
  return {
    "workbench.colorTheme": type === "dark" ? "Cake Dark" : "Cake Light",
    "workbench.colorCustomizations": custom?.colors ?? {},
    "editor.tokenColorCustomizations": custom ? { textMateRules: custom.tokenColors } : {},
    "editor.semanticTokenColorCustomizations": custom
      ? { enabled: custom.semanticHighlighting, rules: custom.semanticTokenColors }
      : {},
  };
}
