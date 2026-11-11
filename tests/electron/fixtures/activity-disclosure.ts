import { expect, type Locator } from "@playwright/test";

/** Exercise the inset disclosure in real conversation workflows, not a synthetic mount. */
export async function verifyInlineActivity(activity: Locator, composer: Locator) {
  const dock = activity.locator('xpath=ancestor::*[@data-slot="composer-dock"]');
  const details = dock.getByRole("region", { name: "Conversation activity" });
  const form = dock.locator("form");
  const collapsedInput = (await form.boundingBox())!;
  await expect(activity).toHaveAttribute("aria-expanded", "false");
  const autoMerge = dock.getByRole("switch", { name: /^Auto-merge:/ });
  if (await autoMerge.count()) {
    await expect(autoMerge).toBeVisible();
    await expect(autoMerge).toHaveAttribute("aria-checked", "false");
    await autoMerge.focus();
    await autoMerge.press("Shift+Tab");
    await expect(activity).toBeFocused();
    await autoMerge.focus();
    await expect(autoMerge).toBeFocused();
    await autoMerge.press("Space");
    await expect(autoMerge).toHaveAttribute("aria-checked", "true");
    await expect(activity).toHaveAttribute("aria-expanded", "false");
    await autoMerge.press("Enter");
    await expect(autoMerge).toHaveAttribute("aria-checked", "false");
  }
  await activity.click();
  await expect(activity).toHaveAttribute("aria-expanded", "true");
  await expect(details).toHaveAttribute("id", (await activity.getAttribute("aria-controls"))!);
  const strip = (await activity.boundingBox())!;
  const expanded = (await details.boundingBox())!;
  const expandedInput = (await form.boundingBox())!;
  expect(expanded.y).toBeGreaterThanOrEqual(strip.y + strip.height - 1);
  expect(expanded.y + expanded.height).toBeLessThanOrEqual(expandedInput.y);
  expect(Math.abs(expandedInput.y - collapsedInput.y)).toBeLessThan(2);
  expect(expanded.height).toBeLessThanOrEqual(168);
  expect(expanded.y).toBeGreaterThan(0);

  await expect(details.getByRole("switch")).toHaveCount(0);
  if (await autoMerge.count()) {
    await autoMerge.click();
    await expect(autoMerge).toHaveAttribute("aria-checked", "true");
    await expect(details).toBeVisible();
    await autoMerge.click();
    await expect(autoMerge).toHaveAttribute("aria-checked", "false");
  }
  const firstItem = details
    .getByRole("button", { name: /^(Open session|Inspect subagent):/ })
    .first();
  await firstItem.focus();
  await firstItem.press("Shift+Tab");
  if (await autoMerge.count()) {
    await expect(autoMerge).toBeFocused();
    await autoMerge.press("Shift+Tab");
  }
  await expect(activity).toBeFocused();
  await composer.click();
  await expect(composer).toBeFocused();
  await composer.pressSequentially("Keep activity draft");
  await expect(composer).toHaveValue("Keep activity draft");
  await expect(dock.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
  await composer.press("Escape");
  await expect(composer).toBeFocused();
  await expect(details).toBeVisible();
  await activity.click();
  await expect(activity).toHaveAttribute("aria-expanded", "false");
  await expect(details).toHaveCount(0);
  expect(Math.abs((await form.boundingBox())!.y - collapsedInput.y)).toBeLessThan(2);
  await activity.press("Enter");
  await expect(details).toBeVisible();
  await activity.press("Space");
  await expect(details).toHaveCount(0);
  await expect(composer).toHaveValue("Keep activity draft");
  await activity.press("Enter");
  await expect(details).toBeVisible();
  await firstItem.focus();
  return details;
}
