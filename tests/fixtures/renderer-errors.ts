import type { Page } from "@playwright/test";

/**
 * Records the renderer's window `error` events from now on. Chromium reports
 * "ResizeObserver loop completed with undelivered notifications" this way, not
 * as a Playwright `pageerror`. Never suppress or intercept these events.
 */
export async function recordRendererErrors(page: Page) {
  await page.evaluate(() => {
    const errors: string[] = [];
    Reflect.set(window, "recordedRendererErrors", errors);
    window.addEventListener("error", (event) => errors.push(event.message));
  });
}

export async function recordedRendererErrors(page: Page): Promise<string[]> {
  return page.evaluate(() => Reflect.get(window, "recordedRendererErrors") as string[]);
}
