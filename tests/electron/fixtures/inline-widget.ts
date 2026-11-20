import { readFile } from "node:fs/promises";
import {
  compileInlineWidget,
  type InlineWidgetCapability,
  type InlineWidgetLanguage,
} from "../../../src/services/widgets/inline-widget-service";

/**
 * Compiles an inline widget from a Playwright spec. Specs load without Vite's `?raw` import
 * hook, so they supply the shared scrollbar stylesheet that the app bundle embeds.
 */
export async function compileFixtureInlineWidget(
  language: InlineWidgetLanguage,
  source: string,
  capability: InlineWidgetCapability,
) {
  const scrollbarStyles = await readFile(
    new URL("../../../src/utils/scrollbars.css", import.meta.url),
    "utf8",
  );
  return compileInlineWidget(language, source, capability, { scrollbarStyles });
}
