import { mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { expect, type Locator } from "@playwright/test";

/** Exercise only the immutable prototype in the harness's isolated Cake instance. */
export async function verifyStackedAttentionPrototype(iframe: Locator) {
  const frame = iframe.contentFrame();
  const theme = await frame.locator("html").getAttribute("data-theme");
  const output = resolve(".visual-captures/stacked-attention-r2");
  await mkdir(output, { recursive: true });
  await frame.locator(".comparison").screenshot({ path: join(output, `${theme}-comparison.png`) });
  await frame.getByRole("button", { name: "Conversation", exact: true }).click();
  const draft = frame.getByRole("textbox");
  await draft.fill("Keep this discussion separate from queued review.");
  const activity = frame.locator('[data-section="activity"]');
  const attention = frame.locator('[data-section="attention"]');
  const activityPanel = frame.locator("#live-activity-panel");
  const attentionPanel = frame.locator("#live-attention-panel");
  for (let variant = 1; variant <= 5; variant++) {
    await frame.locator(`.option[data-variant="${variant}"]`).click();
    for (const width of ["wide", "narrow"] as const) {
      await frame.locator(`[data-width="${width}"]`).click();
      const paneWidth = await frame
        .locator(".app")
        .evaluate((el) => el.getBoundingClientRect().width);
      expect(paneWidth).toBe(width === "wide" ? 820 : 360);
      // Chromium keyboard input rather than dispatchEvent-based assertions.
      await activity.focus();
      await activity.press("Enter");
      await expect(activityPanel).toBeVisible();
      await activity.press("ArrowDown");
      await expect(attention).toBeFocused();
      await attention.press("Space");
      await expect(attentionPanel).toBeVisible();
      await expect(activityPanel).toBeHidden();
      await attention.press("Space");
      await expect(activityPanel).toBeHidden();
      await expect(attentionPanel).toBeHidden();
      await attention.press("Home");
      await expect(activity).toBeFocused();
      await activity.press("End");
      await expect(attention).toBeFocused();
      await attention.press("ArrowUp");
      await expect(activity).toBeFocused();
      await activity.press("Enter");
      await activityPanel.getByRole("button").first().press("Escape");
      await expect(activity).toBeFocused();
      await expect(activityPanel).toBeHidden();
      await attention.click();
      await draft.focus();
      await draft.press("Escape");
      await expect(draft).toBeFocused();
      await expect(attentionPanel).toBeVisible();
      await expect(draft).toHaveValue("Keep this discussion separate from queued review.");
      await expect(activity).toHaveAttribute(
        "aria-label",
        /3 running, 2 project sessions and 1 temporary subagent/,
      );
      await expect(attention).toHaveAttribute("aria-label", /2 to-dos/);
      const geometry = await frame.locator(".app").evaluate((el) => {
        const panel = el.querySelector<HTMLElement>("#live-attention-panel")!;
        const composer = el.querySelector("textarea")!.getBoundingClientRect();
        return {
          panel: panel.getBoundingClientRect().height,
          bound: Math.min(168, innerHeight * 0.25),
          composerVisible:
            composer.top >= el.getBoundingClientRect().top &&
            composer.bottom <= el.getBoundingClientRect().bottom,
          headersFit: Array.from(el.querySelectorAll<HTMLElement>(".header")).every(
            (h) => h.scrollWidth <= h.clientWidth,
          ),
          paneFits: el.scrollWidth <= el.clientWidth,
        };
      });
      expect(geometry.panel).toBeLessThanOrEqual(geometry.bound + 1);
      expect(geometry.composerVisible).toBe(true);
      expect(geometry.headersFit).toBe(true);
      expect(geometry.paneFits).toBe(true);
      await frame
        .locator(".app")
        .screenshot({ path: join(output, `${theme}-${variant}-${width}-attention.png`) });
      await attention.click();
    }
  }
  await frame.locator('.option[data-variant="1"]').click();
  await frame.locator('[data-width="wide"]').click();
  await frame.locator(".app").screenshot({ path: join(output, `${theme}-both-collapsed.png`) });
  await frame.locator(".checks summary").click();
  await frame.getByRole("button", { name: "Run local DOM checks" }).click();
  const summary = frame.locator("#check-results li").first();
  await expect(summary).toHaveText(/\d+\/\d+ local DOM assertions passed/);
  const counts = (await summary.innerText()).match(/(\d+)\/(\d+)/)!;
  expect(Number(counts[1])).toBe(Number(counts[2]));
  expect(Number(counts[2])).toBeGreaterThan(100);
  await expect(frame.locator("#check-results .fail")).toHaveCount(0);
  await expect(draft).toHaveValue("Keep this discussion separate from queued review.");
  console.log(
    `STACKED_PROTOTYPE_CHECKS ${JSON.stringify({ theme, variants: 5, widths: [820, 360], domAssertions: Number(counts[2]), realKeyboard: true, artifact: "cake://artifact/stacked-attention-accordions@r2", output })}`,
  );
  await frame.getByRole("button", { name: "Compare", exact: true }).click();
}
