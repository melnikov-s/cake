import type { Locator, Page } from "@playwright/test";

/**
 * Moves the pointer onto an element where it is painted, as a reader does.
 * Unlike `Locator.hover`, this never scrolls programmatically: Playwright's
 * scroll-into-view is not reader input, so a following transcript may move back
 * and dismiss the tooltip the reader is waiting for.
 */
export async function pointAt(page: Page, target: Locator) {
  const box = await target.boundingBox();
  if (!box) throw new Error("pointAt: the target is not painted");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 4 });
}

/**
 * Scrolls `scroller` with the mouse wheel until `target` lies in its upper reading
 * area: clear of the top chrome and of a composer docked over the bottom.
 */
export async function wheelIntoView(page: Page, scroller: Locator, target: Locator) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const [viewport, box] = await Promise.all([scroller.boundingBox(), target.boundingBox()]);
    if (!viewport) throw new Error("wheelIntoView: the scroller is not painted");
    const top = viewport.y + 48;
    const bottom = viewport.y + viewport.height * 0.65;
    if (box && box.y >= top && box.y + box.height <= bottom) return;
    await page.mouse.move(viewport.x + viewport.width / 2, viewport.y + viewport.height / 2);
    const delta = box ? box.y - (viewport.y + viewport.height / 3) : -viewport.height / 2;
    if (box && Math.abs(delta) < 1) return;
    const before = await scroller.evaluate((element) => element.scrollTop);
    await page.mouse.wheel(0, Math.sign(delta) * Math.min(Math.abs(delta), viewport.height / 2));
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    // At either end of the transcript the target is as visible as reading can make it.
    if (box && (await scroller.evaluate((element) => element.scrollTop)) === before) return;
  }
  throw new Error("wheelIntoView: the target never scrolled into view");
}
