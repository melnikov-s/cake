import { expect, type Locator } from "@playwright/test";

/** Exercise the shared disclosure in real conversation workflows, not a synthetic mount. */
export async function verifyInlineActivity(activity: Locator, composer: Locator) {
  const dock = activity.locator('xpath=ancestor::*[@data-slot="composer-dock"]');
  const details = dock.getByRole("region", { name: "Conversation activity" });
  const form = dock.locator("form");
  const collapsedInput = (await form.boundingBox())!;
  await expect(activity).toHaveAttribute("aria-expanded", "false");

  // The chevron and the rest of the bar are one native keyboard-accessible button.
  await activity.locator("svg").click();
  await expect(activity).toHaveAttribute("aria-expanded", "true");
  await expect(details).toHaveAttribute("id", (await activity.getAttribute("aria-controls"))!);
  const strip = (await activity.boundingBox())!;
  const expanded = (await details.boundingBox())!;
  const expandedInput = (await form.boundingBox())!;
  expect(Math.abs(strip.y + strip.height - expanded.y)).toBeLessThan(2);
  expect(Math.abs(expanded.y + expanded.height - expandedInput.y)).toBeLessThan(2);
  expect(Math.abs(expandedInput.y - collapsedInput.y)).toBeLessThan(2);
  expect(expanded.y).toBeGreaterThan(0);

  await activity.press("Tab");
  await expect(details.getByRole("button").first()).toBeFocused();
  await composer.click();
  await expect(composer).toBeFocused();
  await composer.pressSequentially("Keep activity draft");
  await expect(composer).toHaveValue("Keep activity draft");
  await expect(dock.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
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
  await details.getByRole("button").first().focus();
  return details;
}
