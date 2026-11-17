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
    description:
      "Floating identity on the chat canvas, title ellipsis, and persistent Appearance toggle",
    states: [
      "project-chat",
      "long-title",
      "short-title",
      "hidden",
      "browser",
      "global-chat",
      "staged",
      "staged-browser",
    ],
    seed: titles.seed,
    async prepare(page, state, application) {
      await titles.prepare(
        page,
        state === "project-chat" || state.startsWith("staged")
          ? "project-chat"
          : state === "short-title"
            ? "short-title"
            : "long-title",
        application,
      );
      // The title scenario ends over the dynamic rail; dismiss its intentional overlay before hit tests.
      await page.mouse.move(500, 80);
      await expect
        .poll(async () => (await page.locator('[data-slot="project-rail"]').boundingBox())?.width)
        .toBe(54);
      const header = page.getByRole("navigation", { name: "Conversation breadcrumb" });
      const identity = page.getByRole("navigation", { name: "Conversation identity" });
      if (state.startsWith("staged")) {
        await page.getByRole("button", { name: "New session", exact: true }).click();
        await page.getByRole("option", { name: /visual-capture-project/ }).click();
        await expect(page.getByRole("combobox", { name: "Message", exact: true })).toBeVisible();
        await expect(header).toHaveText("visual-capture-project›New chat");
        await expect(identity).toHaveText("visual-capture-project›New chat");
        await expect(
          identity.getByRole("button", { name: "New chat", exact: true }),
        ).toHaveAttribute("aria-current", "page");
        if (state === "staged-browser") {
          await page.getByRole("button", { name: "Browser", exact: true }).click();
          await expect(header).toHaveText("visual-capture-project›New chat");
          await page
            .getByRole("group", { name: "Companion content" })
            .getByRole("button", { name: "Chat", exact: true })
            .click();
          await expect(identity).toHaveText("visual-capture-project›New chat");
        }
        await page
          .getByRole("combobox", { name: "Message", exact: true })
          .fill("Unsent project draft");
        await expect(
          page
            .getByRole("navigation", { name: "Conversation breadcrumb" })
            .getByRole("button", { name: "Cake Chat", exact: true }),
        ).toHaveCount(0);
        return;
      }
      if (state === "global-chat") {
        await page.getByRole("button", { name: "Open Cake Chat", exact: true }).click();
        await expect(header).toHaveText("Cake Chat");
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
      const eligible = state !== "project-chat" && state !== "global-chat";
      if (eligible) await expect(identity).toBeVisible();
      else {
        await expect(identity).toHaveCount(0);
        await expect(page.locator('[data-slot="conversation-identity-layout"]')).toHaveCount(0);
      }
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
      } else if (eligible) {
        const geometry = await identity.evaluate((nav) => {
          const tab = nav.closest('[data-slot="conversation-identity-tab"]')!;
          const layout = tab.closest('[data-slot="conversation-identity-layout"]')!;
          const chat = layout.querySelector('[data-slot="chat"]')!;
          const composer = layout.querySelector(".workbench-composer")!;
          const bounds = tab.getBoundingClientRect();
          const column = layout.getBoundingClientRect();
          const style = getComputedStyle(tab);
          const positioner = tab.parentElement!;
          const positionerStyle = getComputedStyle(positioner);
          const layoutStyle = getComputedStyle(layout);
          // Resolve the actual paint behind Chat, including transparent intermediate wrappers.
          let canvas: Element | null = chat;
          while (canvas && getComputedStyle(canvas).backgroundColor === "rgba(0, 0, 0, 0)")
            canvas = canvas.parentElement;
          const outside = document.elementFromPoint(
            column.left + 2,
            bounds.top + bounds.height / 2,
          );
          return {
            centerDelta: bounds.left + bounds.width / 2 - (column.left + column.width / 2),
            bottomDelta: column.bottom - bounds.bottom,
            height: bounds.height,
            width: bounds.width,
            columnWidth: column.width,
            canvasBackground: canvas && getComputedStyle(canvas).backgroundColor,
            layoutBackground: layoutStyle.backgroundColor,
            positionerPosition: positionerStyle.position,
            positionerBackground: positionerStyle.backgroundColor,
            positionerBorder: positionerStyle.borderWidth,
            positionerShadow: positionerStyle.boxShadow,
            positionerPointerEvents: positionerStyle.pointerEvents,
            tabPointerEvents: style.pointerEvents,
            outsideHitsPositioner: outside === positioner,
            inside: bounds.left >= column.left && bounds.right <= column.right,
            chatBeforeTab: chat.getBoundingClientRect().bottom <= bounds.top,
            composerBeforeTab: composer.getBoundingClientRect().bottom <= bounds.top,
            topRadius: parseFloat(style.borderTopLeftRadius),
            bottomRadius: parseFloat(style.borderBottomLeftRadius),
            navOverflow: nav.scrollWidth - nav.clientWidth,
          };
        });
        expect(Math.abs(geometry.centerDelta)).toBeLessThanOrEqual(1);
        expect(geometry.bottomDelta).toBe(8);
        expect(geometry.height).toBe(28);
        expect(geometry.layoutBackground).toBe(geometry.canvasBackground);
        expect(geometry.positionerPosition).toBe("absolute");
        expect(geometry.positionerBackground).toBe("rgba(0, 0, 0, 0)");
        expect(geometry.positionerBorder).toBe("0px");
        expect(geometry.positionerShadow).toBe("none");
        expect(geometry.positionerPointerEvents).toBe("none");
        expect(geometry.tabPointerEvents).toBe("auto");
        expect(geometry.outsideHitsPositioner).toBe(false);
        expect(geometry.width).toBeLessThanOrEqual(Math.min(576, geometry.columnWidth - 32));
        if (state === "short-title") expect(geometry.width).toBeLessThan(geometry.columnWidth / 2);
        expect(geometry.inside).toBe(true);
        expect(geometry.chatBeforeTab).toBe(true);
        expect(geometry.composerBeforeTab).toBe(true);
        expect(geometry.topRadius).toBeGreaterThan(0);
        expect(geometry.bottomRadius).toBe(geometry.topRadius);
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
        // Exercise real navigation from the floating label, not just its header counterpart.
        const sessionTitle = await identity.locator('[aria-current="page"]').getAttribute("title");
        await identity.getByRole("button", { name: "visual-capture-project", exact: true }).click();
        await expect(
          page.getByRole("combobox", { name: "Message Project Chat", exact: true }),
        ).toBeVisible();
        await expect(identity).toHaveCount(0);
        await page.getByRole("button", { name: "Search sessions", exact: true }).click();
        await page.keyboard.type(sessionTitle!);
        await page
          .getByRole("option", { name: new RegExp(sessionTitle!) })
          .first()
          .click();
        await expect(identity).toBeVisible();
        await expect(input).toHaveValue("Keep this draft");
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
