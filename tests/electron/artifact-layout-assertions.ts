import { expect, type Locator, type Page } from "@playwright/test";

/** Assert against the actual rail edge, including hover/focus expansion and hidden rails. */
export async function expectPresentationFitsRail(page: Page, surface: Locator) {
  await expect(async () => {
    const rail = await page.locator('[data-slot="project-rail"]').boundingBox();
    const bounds = (await surface.boundingBox())!;
    const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    const left = rail ? rail.x + rail.width : 0;
    expect(bounds.x).toBeCloseTo(left, 0);
    expect(bounds.y).toBe(0);
    expect(bounds.width).toBeCloseTo(viewport.width - left, 0);
    expect(bounds.height).toBe(viewport.height);
    // Visibility alone does not detect an overlaid rail: prove the left edge is hit-testable.
    expect(
      await surface.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        return element.contains(document.elementFromPoint(bounds.left + 1, bounds.top + 100));
      }),
    ).toBe(true);
  }).toPass();
}
