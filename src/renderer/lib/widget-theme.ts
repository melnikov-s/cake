import type { EditorColorTheme } from "../../contracts/themes/color-theme";
import {
  widgetThemeColorTokens,
  widgetThemeFontTokens,
  type WidgetTheme,
} from "../../utils/widget-theme";

/** Read the host's resolved tokens, rather than maintaining a widget palette. */
export function readWidgetTheme(theme: EditorColorTheme): WidgetTheme {
  const colorScheme = theme === "light" || theme === "dark" ? theme : theme.type;
  const styles = getComputedStyle(document.documentElement);
  return {
    colorScheme,
    tokens: Object.fromEntries(
      [...widgetThemeColorTokens, ...widgetThemeFontTokens].map((name) => [
        name,
        styles.getPropertyValue(`--${name}`).trim(),
      ]),
    ),
  };
}
