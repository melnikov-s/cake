/** Shared semantic colors available to every opaque-origin Cake widget. */
export const widgetThemeColorTokens = [
  "background",
  "foreground",
  "card",
  "card-foreground",
  "popover",
  "popover-foreground",
  "primary",
  "primary-foreground",
  "secondary",
  "secondary-foreground",
  "muted",
  "muted-foreground",
  "accent",
  "accent-foreground",
  "border",
  "input",
  "ring",
  "success",
  "attention",
  "warning",
  "destructive",
  "destructive-foreground",
  "composer",
] as const;

export const widgetThemeFontTokens = ["font-sans", "font-mono"] as const;

export interface WidgetTheme {
  colorScheme: "light" | "dark";
  tokens: Record<string, string>;
}
