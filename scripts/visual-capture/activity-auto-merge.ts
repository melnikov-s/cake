import { expect, type Locator, type Page } from "@playwright/test";

/** Real project authorization through the collapsed Activity bar; no readiness or Git landing. */
export async function verifyActivityAutoMerge(page: Page, cap: Locator, enabled: boolean) {
  const activity = cap.getByRole("button", { name: "Activity · 1 running" });
  const toggle = cap.getByRole("switch", { name: /^Auto-merge:/ });
  const label = cap.getByText("Auto-merge", { exact: true });
  const icon = label.locator("svg");
  await expect(activity).toHaveAttribute("aria-expanded", "false");
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveCount(1);
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expect(label).toBeVisible();
  const offColor = await icon.evaluate((element) => getComputedStyle(element).color);
  const mergedColor = await icon.evaluate((element) => {
    const sample = document.createElement("span");
    sample.style.color = "var(--worktree-merged)";
    element.parentElement!.appendChild(sample);
    const color = getComputedStyle(sample).color;
    sample.remove();
    return color;
  });
  expect(offColor).not.toBe(mergedColor);

  // Plain Tab is Cake’s composer shortcut. Reverse traversal and native activation remain available.
  await toggle.focus();
  await toggle.press("Shift+Tab");
  await expect(activity).toBeFocused();
  await toggle.focus();
  await expect(toggle).toBeFocused();
  await toggle.press("Space");
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await expect(icon).toHaveCSS("color", mergedColor);
  await expect(activity).toHaveAttribute("aria-expanded", "false");
  await toggle.press("Enter");
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expect(icon).toHaveCSS("color", offColor);

  // Label activation also changes only the switch, without opening Activity.
  if (enabled) await label.click();
  await expect(toggle).toHaveAttribute("aria-checked", String(enabled));
  await expect(activity).toHaveAttribute("aria-expanded", "false");
  await expect(cap.getByRole("region", { name: "Conversation activity" })).toHaveCount(0);
  await activity.click();
  await expect(
    cap.getByRole("region", { name: "Conversation activity" }).getByRole("switch"),
  ).toHaveCount(0);
  await expect(toggle).toHaveCount(1);
  await activity.click();

  const row = activity.locator("xpath=../..");
  const geometry = await row.evaluate((element) => {
    const trigger = element.querySelector("button")!.getBoundingClientRect();
    const control = element.querySelector('[role="switch"]')!.getBoundingClientRect();
    const label = element.querySelector("label")!.getBoundingClientRect();
    const bounds = element.getBoundingClientRect();
    return {
      overflow: element.scrollWidth > element.clientWidth,
      labelFits: label.left >= bounds.left && label.right <= bounds.right,
      sameRow: Math.abs(trigger.top + trigger.height / 2 - control.top - control.height / 2) < 2,
    };
  });
  expect(geometry).toEqual({ overflow: false, labelFits: true, sameRow: true });
  await page.mouse.move(1, 1);
}
