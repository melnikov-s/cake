import { expect } from "@playwright/test";
import type { VisualCaptureScenario } from "./scenarios";
import { createSessionHeaderTitleScenario } from "./session-header-title";

/** Real primary chat, composer and settings; no renderer-store injection. */
export function createConversationIdentityScenario(
  base: VisualCaptureScenario,
): VisualCaptureScenario {
  const titles = createSessionHeaderTitleScenario(base);
  return {
    name: "conversation-identity",
    description: "Bottom-docked identity, long-title ellipsis, and persistent Appearance toggle",
    states: ["project-chat", "long-title", "hidden", "browser", "global-chat"],
    seed: titles.seed,
    async prepare(page, state, application) {
      await titles.prepare(
        page,
        state === "project-chat" ? "project-chat" : "long-title",
        application,
      );
      // The title scenario ends over the dynamic rail; dismiss its intentional overlay before hit tests.
      await page.mouse.move(500, 80);
      await expect
        .poll(async () => (await page.locator('[data-slot="project-rail"]').boundingBox())?.width)
        .toBe(54);
      const header = page.getByRole("navigation", { name: "Conversation breadcrumb" });
      const identity = page.getByRole("navigation", { name: "Conversation identity" });
      if (state === "global-chat") {
        await page.getByRole("button", { name: "Open Cake Chat", exact: true }).click();
        await expect(identity).toHaveText("Cake Chat");
      } else if (state === "browser") {
        await page.getByRole("button", { name: "Browser", exact: true }).click();
        await expect(
          page.getByRole("complementary", { name: "Current conversation companion" }),
        ).toBeVisible();
        await page
          .getByRole("group", { name: "Companion content" })
          .getByRole("button", { name: "Chat", exact: true })
          .click();
      }
      await expect(identity).toBeVisible();
      const beforeHeader = await header.textContent();
      const input = page.getByRole("combobox", { name: /^Message(?: Project Chat| Cake Chat)?$/ });
      await input.fill("Keep this draft");
      if (state === "hidden") {
        await page.getByRole("button", { name: "Settings", exact: true }).click();
        await page.getByRole("button", { name: /^Appearance/ }).click();
        const toggle = page.getByRole("switch", { name: "Conversation identity tab", exact: true });
        await expect(toggle).toHaveAttribute("aria-checked", "true");
        await toggle.click();
        await page.getByRole("button", { name: "Back to chat", exact: true }).click();
        await expect(identity).toHaveCount(0);
        await expect(page.locator('[data-slot="conversation-identity-layout"]')).toHaveCount(0);
        await expect(header).toHaveText(beforeHeader!);
        await expect(input).toHaveValue("Keep this draft");
        // Reopening settings proves saved UI state, not a transient dismissal.
        await page.getByRole("button", { name: "Settings", exact: true }).click();
        await page.getByRole("button", { name: /^Appearance/ }).click();
        await expect(toggle).toHaveAttribute("aria-checked", "false");
        await page.getByRole("button", { name: "Back to chat", exact: true }).click();
      } else {
        const geometry = await identity.evaluate((nav) => {
          const tab = nav.closest('[data-slot="conversation-identity-tab"]')!;
          const layout = tab.closest('[data-slot="conversation-identity-layout"]')!;
          const chat = layout.querySelector('[data-slot="chat"]')!;
          const composer = layout.querySelector(".workbench-composer")!;
          const bounds = tab.getBoundingClientRect();
          const column = layout.getBoundingClientRect();
          const style = getComputedStyle(tab);
          return {
            centerDelta: bounds.left + bounds.width / 2 - (column.left + column.width / 2),
            bottomDelta: column.bottom - bounds.bottom,
            height: bounds.height,
            inside: bounds.left >= column.left && bounds.right <= column.right,
            chatBeforeTab: chat.getBoundingClientRect().bottom <= bounds.top,
            composerBeforeTab: composer.getBoundingClientRect().bottom <= bounds.top,
            topRadius: parseFloat(style.borderTopLeftRadius),
            bottomRadius: parseFloat(style.borderBottomLeftRadius),
            navOverflow: nav.scrollWidth - nav.clientWidth,
          };
        });
        expect(Math.abs(geometry.centerDelta)).toBeLessThanOrEqual(1);
        expect(Math.abs(geometry.bottomDelta)).toBeLessThanOrEqual(1);
        expect(geometry.height).toBe(28);
        expect(geometry.inside).toBe(true);
        expect(geometry.chatBeforeTab).toBe(true);
        expect(geometry.composerBeforeTab).toBe(true);
        expect(geometry.topRadius).toBeGreaterThan(0);
        expect(geometry.bottomRadius).toBe(0);
        expect(geometry.navOverflow).toBeLessThanOrEqual(1);
        for (const button of await identity.getByRole("button").all())
          await button.click({ trial: true });
        await page.getByRole("button", { name: "Send", exact: true }).click({ trial: true });
        await expect(input).toHaveValue("Keep this draft");
        // Native scrolling belongs to the existing transcript, not the identity row.
        const transcript = page.locator(".transcript").first();
        await expect(transcript).toHaveCSS("overflow-y", "auto");
        const scrollTop = await transcript.evaluate((element) => element.scrollTop);
        const tabTop = (await identity.boundingBox())!.y;
        await transcript.hover();
        await page.mouse.wheel(0, -800);
        if (scrollTop > 0)
          await expect
            .poll(() => transcript.evaluate((element) => element.scrollTop))
            .toBeLessThan(scrollTop);
        expect((await identity.boundingBox())!.y).toBe(tabTop);
        await expect(identity).toBeVisible();
        await expect(header).toHaveText(beforeHeader!);
        console.log("CONVERSATION_IDENTITY_GEOMETRY", JSON.stringify({ state, ...geometry }));
      }
      await page.mouse.move(500, 80);
      await expect
        .poll(async () => (await page.locator('[data-slot="project-rail"]').boundingBox())?.width)
        .toBe(54);
    },
    region: (page) => page.locator("body"),
  };
}
