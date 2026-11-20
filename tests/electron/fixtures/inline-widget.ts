import { readFile } from "node:fs/promises";
import { expect, type Locator } from "@playwright/test";
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

/**
 * Hovers a control inside a widget frame until the widget itself receives the pointer.
 *
 * Hidden smoke windows refresh out-of-process iframe hit-test regions lazily. Pointer input sent
 * right after a widget frame first paints can be routed to the host's `<iframe>` element instead:
 * the host document records pointerdown/click on IFRAME while the widget document records
 * nothing, so a real click is silently lost. Hover has no effect on these widgets, so moving the
 * real pointer until the control matches `:hover` proves routing before the click under test.
 */
export async function pointAtWidgetControl(control: Locator) {
  await expect
    .poll(async () => {
      await control.hover();
      return control.evaluate((element) => element.matches(":hover"));
    })
    .toBe(true);
}
