import { Schema } from "effect";
import {
  AppearanceMode,
  ColorThemeChoice,
  ImportedColorTheme,
  VsCodeThemeSource,
} from "./color-theme";

const ColorScheme = Schema.Literals(["light", "dark"]);
const ThemeSummary = Schema.Struct({
  choice: ColorThemeChoice,
  name: Schema.NonEmptyString,
  type: ColorScheme,
});
const ThemeDetail = Schema.Struct({
  ...ThemeSummary.fields,
  theme: Schema.Union([ColorScheme, ImportedColorTheme]),
});
export const ThemeState = Schema.Struct({
  appearance: AppearanceMode,
  systemColorScheme: ColorScheme,
  lightTheme: ColorThemeChoice,
  darkTheme: ColorThemeChoice,
  effective: Schema.Struct({ ...ThemeSummary.fields, saved: Schema.Boolean }),
});
export interface ThemeState extends Schema.Schema.Type<typeof ThemeState> {}

const name = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(200));
export const ThemeAddInput = Schema.Union([
  Schema.Struct({ name, theme: VsCodeThemeSource }),
  Schema.Struct({
    name,
    entry: Schema.NonEmptyString,
    files: Schema.Record(Schema.String, Schema.String),
  }),
]);
export type ThemeAddInput = Schema.Schema.Type<typeof ThemeAddInput>;
export const ThemeApplyInput = Schema.Struct({
  choice: ColorThemeChoice,
  application: Schema.Literals(["now", "when-active"]),
});
export interface ThemeApplyInput extends Schema.Schema.Type<typeof ThemeApplyInput> {}

const commonGuidance = [
  "Uses the existing persisted appearance catalog in the Cake window showing the calling chat. Requires a connected eligible desktop window; never edit settings files.",
  "Use exact choice IDs from list/read/add, not display names. Custom names may repeat; add creates a new ID and never overwrites a theme. Only saved themes can be read or applied.",
  "State reports saved Light/Dark slots, appearance (Light/Dark/System), OS scheme, and the effective live theme. UI previews, if any, are marked saved:false. Cake and embedded editors use the existing shared live theme projection; this is not an editor-render acknowledgement.",
  "A persistence failure is not success and can leave live in-memory changes. Read back before retrying; add always creates a new theme.",
];

export const themeOperationDefinitions = {
  "themes.list": {
    command: "themes.list",
    args: Schema.Struct({}),
    output: Schema.Struct({ themes: Schema.Array(ThemeSummary), state: ThemeState }),
    scope: "global",
    discovery: {
      topic: "themes",
      summary: "List saved bundled/custom Cake themes and effective window appearance.",
      guidance: commonGuidance,
    },
  },
  "themes.read": {
    command: "themes.read",
    args: Schema.Struct({ choice: ColorThemeChoice }),
    output: Schema.Struct({ theme: ThemeDetail, state: ThemeState }),
    scope: "global",
    discovery: {
      topic: "themes",
      summary: "Read one saved theme by exact choice ID, including palette and syntax data.",
      guidance: [
        ...commonGuidance,
        "Cake Light/Dark return their built-in mode string; other themes return full normalized palette and syntax data.",
      ],
    },
  },
  "themes.add": {
    command: "themes.add",
    args: ThemeAddInput,
    output: Schema.Struct({ theme: ThemeDetail, state: ThemeState }),
    scope: "global",
    discovery: {
      topic: "themes",
      summary:
        "Create/add/import a named custom theme from validated palette or VS Code color-theme data, without applying it.",
      guidance: [
        ...commonGuidance,
        "Supply name and theme:{type,colors,tokenColors?,semanticTokenColors?,semanticHighlighting?}. Palette keys are VS Code color roles (editor.background, editor.foreground, button.background, etc.); values must be hex colors. Missing roles use Cake defaults. Type may be light/dark or inferred from editor.background.",
        "Alternatively supply name, entry, and files:{relativePath:JSON/JSONC text}. Includes resolve only within those supplied files. No filesystem reads, downloads, or extension code execution. A package manifest is not a color theme.",
        "Add only saves. For 'create and apply', use the returned theme.choice with themes.apply application:now, then verify its returned effective state.",
      ],
      examples: [
        {
          input: {
            name: "Halloween",
            theme: {
              type: "dark",
              colors: {
                "editor.background": "#191322",
                "editor.foreground": "#f4e6d5",
                "button.background": "#ed8a27",
                "button.foreground": "#191322",
              },
            },
          },
        },
      ],
    },
  },
  "themes.apply": {
    command: "themes.apply",
    args: ThemeApplyInput,
    output: Schema.Struct({
      theme: ThemeDetail,
      previous: ThemeState,
      state: ThemeState,
      visible: Schema.Boolean,
    }),
    scope: "global",
    discovery: {
      topic: "themes",
      summary:
        "Select a saved theme for its Light/Dark slot, explicitly applying now or only when that mode is active.",
      guidance: [
        ...commonGuidance,
        "application is required: now makes the theme visible immediately. It preserves appearance if its mode is already visible (including System); otherwise switches appearance to the theme's Light/Dark mode, leaving System. The opposite slot is never changed.",
        "when-active saves the theme's own slot without changing Light/Dark/System appearance. It is visible now only if that mode is active. Check visible and state.effective; never claim an inactive-slot selection is visible.",
        "Use settings.window.update section:appearance changes:{theme:system|light|dark} to change appearance independently of selected themes.",
      ],
      examples: [{ input: { choice: "bundled:nord", application: "now" } }],
    },
  },
} as const;

export type ThemeCommand = keyof typeof themeOperationDefinitions;
export type ThemeControlSuccess = {
  [K in ThemeCommand]: { ok: true; command: K; scope: "window" } & Schema.Schema.Type<
    (typeof themeOperationDefinitions)[K]["output"]
  >;
}[ThemeCommand];
export type ThemeList = Schema.Schema.Type<
  (typeof themeOperationDefinitions)["themes.list"]["output"]
>;
export type ThemeRead = Schema.Schema.Type<
  (typeof themeOperationDefinitions)["themes.read"]["output"]
>;
export type ThemeApply = Schema.Schema.Type<
  (typeof themeOperationDefinitions)["themes.apply"]["output"]
>;

export const themeControlOutput = (definition: (typeof themeOperationDefinitions)[ThemeCommand]) =>
  Schema.Union([
    Schema.Struct({
      ok: Schema.Literal(true),
      command: Schema.Literal(definition.command),
      scope: Schema.Literal("window"),
      ...definition.output.fields,
    }),
    Schema.Struct({
      ok: Schema.Literal(false),
      command: Schema.optionalKey(Schema.String),
      error: Schema.String,
    }),
  ]);
