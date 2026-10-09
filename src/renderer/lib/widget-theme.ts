import {
  widgetThemeColorTokens,
  widgetThemeFontTokens,
  type WidgetTheme,
} from "../../utils/widget-theme";

/** Read the host's resolved tokens, rather than maintaining a widget palette. */
export function readWidgetTheme(colorScheme: "light" | "dark"): WidgetTheme {
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
