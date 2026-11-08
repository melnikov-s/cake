import { expect } from "@playwright/test";
import { seedSideChatTabs, sideChatTabTitles } from "../../tests/fixtures/side-chat-tabs";
import type { VisualCaptureScenario } from "./scenarios";

export const sideChatTabsScenario: VisualCaptureScenario = {
  name: "side-chat-tabs",
  description: "Long sibling Side Chat tabs in a bounded pane, with keyboard and overflow states",
  states: ["default", "hover", "focus", "overflow"],
  seed: (paths, theme) => seedSideChatTabs(paths.cakeHome, paths.userData, paths.project, theme),
  async prepare(page, state) {
    await page
      .getByRole("button", { name: "Open Project Chat for Tab fixture", exact: true })
      .click();
    await expect(
      page.getByRole("combobox", { name: "Message Project Chat", exact: true }),
    ).toBeFocused();
    await page.getByRole("button", { name: "Side chats, 5 open", exact: true }).click();
    await page
      .getByRole("dialog", { name: "Open side chats" })
      .getByRole("button", { name: sideChatTabTitles[0], exact: true })
      .click();
    const strip = page.getByRole("tablist", { name: "Side chats", exact: true });
    await expect(strip.getByRole("tab")).toHaveCount(5);
    await expect(page.getByText("A side conversation", { exact: true })).toBeVisible();
    await page.waitForFunction(() => document.fonts.status === "loaded");
    const first = strip.getByRole("tab").first();
    if (state === "hover") await strip.getByRole("tab").nth(1).hover();
    else if (state === "focus" || state === "overflow") {
      await first.focus();
      await page.keyboard.press(state === "focus" ? "ArrowRight" : "End");
    } else await page.mouse.move(1, 1);
  },
  region: (page) => page.getByRole("complementary", { name: sideChatTabTitles[0], exact: true }),
};
