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
 * Scrolls with the mouse wheel until `target` lies in the upper reading area of
 * `scroller`: clear of the top chrome and of a composer docked over the bottom.
 * The wheel turns over the target where possible, so a nested scroll area (a Work
 * log) takes the gesture first, as it does for a reader.
 */
export async function wheelIntoView(page: Page, scroller: Locator, target: Locator) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const [viewport, box] = await Promise.all([scroller.boundingBox(), target.boundingBox()]);
    if (!viewport) throw new Error("wheelIntoView: the scroller is not painted");
    const top = viewport.y + 48;
    const bottom = viewport.y + viewport.height * 0.65;
    if (box && box.y >= top && box.y + box.height <= bottom) return;
    const x = box ? box.x + Math.min(box.width / 2, 40) : viewport.x + viewport.width / 2;
    const y = box
      ? Math.min(Math.max(box.y + box.height / 2, top), bottom)
      : viewport.y + viewport.height / 2;
    await page.mouse.move(x, y);
    const delta = box ? box.y - (viewport.y + viewport.height / 3) : -viewport.height / 2;
    await page.mouse.wheel(0, Math.sign(delta) * Math.min(Math.abs(delta), viewport.height / 2));
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    // At either end of its scroll range the target is as visible as reading can make it.
    const moved = await target.boundingBox();
    if (box && moved && Math.abs(moved.y - box.y) < 1) return;
  }
  throw new Error("wheelIntoView: the target never scrolled into view");
}
