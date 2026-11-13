import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { _electron as electron } from "../../scripts/queued-electron.mjs";
import { sideChatTabsScenario } from "../../scripts/visual-capture/side-chat-tabs";
import { seedSideChatTabs, sideChatTabTitles } from "../fixtures/side-chat-tabs";

const repositoryRoot = resolve(import.meta.dirname, "../..");

test("a single Side Chat keeps its heading and pane close action without a redundant tab strip", async () => {
  const root = await mkdtemp(join(tmpdir(), "cake-single-side-chat-"));
  const paths = {
    cakeHome: join(root, "cake"),
    userData: join(root, "user-data"),
    project: join(root, "project"),
  };
  await seedSideChatTabs(paths.cakeHome, paths.userData, paths.project, "light", 1);
  const application = await electron.launch({
    args: [repositoryRoot],
    cwd: repositoryRoot,
    env: {
      ...process.env,
      CAKE_ELECTRON_SMOKE: "1",
      CAKE_ELECTRON_USER_DATA: paths.userData,
      CAKE_HOME: paths.cakeHome,
      PI_CODING_AGENT_DIR: join(paths.cakeHome, "pi"),
      PI_CODING_AGENT_SESSION_DIR: "",
    },
  });
  try {
    const page = await application.firstWindow();
    await page
      .getByRole("button", { name: "Open Project Chat for Tab fixture", exact: true })
      .click();
    await expect(
      page.getByRole("combobox", { name: "Message Project Chat", exact: true }),
    ).toBeFocused();
    await page.getByRole("button", { name: "Side chats, 1 open", exact: true }).click();
    await page
      .getByRole("dialog", { name: "Open side chats" })
      .getByRole("button", { name: sideChatTabTitles[0], exact: true })
      .click();
    const pane = page.getByRole("complementary", { name: sideChatTabTitles[0], exact: true });
    await expect(pane).toBeVisible();
    await expect(page.getByRole("tablist", { name: "Side chats", exact: true })).toHaveCount(0);
    const close = pane.getByRole("button", { name: "Close side chat", exact: true });
    await close.focus();
    await close.press("Enter");
    await expect(pane).toHaveCount(0);
    await expect(
      page.getByRole("combobox", { name: "Message Project Chat", exact: true }),
    ).toBeVisible();
  } finally {
    await application.close();
    await rm(root, { recursive: true, force: true });
  }
});

for (const action of ["Merge into main chat", "Close and resolve"] as const) {
  test(`${action} selects another Side Chat and closes the pane only after the last tab`, async () => {
    test.setTimeout(120_000);
    const root = await mkdtemp(join(tmpdir(), "cake-remove-side-chat-tab-"));
    const paths = {
      cakeHome: join(root, "cake"),
      userData: join(root, "user-data"),
      project: join(root, "project"),
    };
    await seedSideChatTabs(paths.cakeHome, paths.userData, paths.project, "light", 3);
    const application = await electron.launch({
      args: [repositoryRoot],
      cwd: repositoryRoot,
      env: {
        ...process.env,
        CAKE_ELECTRON_SMOKE: "1",
        CAKE_ELECTRON_USER_DATA: paths.userData,
        CAKE_HOME: paths.cakeHome,
        PI_CODING_AGENT_DIR: join(paths.cakeHome, "pi"),
        PI_CODING_AGENT_SESSION_DIR: "",
      },
    });
    try {
      const page = await application.firstWindow();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page
        .getByRole("button", { name: "Open Project Chat for Tab fixture", exact: true })
        .click();
      await page.getByRole("button", { name: "Side chats, 3 open", exact: true }).click();
      await page
        .getByRole("dialog", { name: "Open side chats" })
        .getByRole("button", { name: sideChatTabTitles[1], exact: true })
        .click();
      const strip = page.getByRole("tablist", { name: "Side chats", exact: true });
      await expect(strip.getByRole("tab")).toHaveCount(3);
      const exitAction = page.getByRole("button", { name: action, exact: true });
      await exitAction.focus();
      await exitAction.press("Enter");
      await expect(strip.getByRole("tab")).toHaveCount(2);
      await expect(
        strip.getByRole("tab", { name: sideChatTabTitles[0], exact: true }),
      ).toHaveAttribute("aria-selected", "true");
      await expect(strip.getByRole("tab", { name: sideChatTabTitles[1], exact: true })).toHaveCount(
        0,
      );
      await page.getByRole("button", { name: action, exact: true }).click();
      const lastPane = page.getByRole("complementary", { name: sideChatTabTitles[2], exact: true });
      await expect(lastPane).toBeVisible();
      await expect(strip).toHaveCount(0);
      await expect(lastPane.getByRole("combobox")).toBeFocused();
      await lastPane.getByRole("button", { name: action, exact: true }).click();
      await expect(lastPane).toHaveCount(0);
      await expect(page.getByRole("button", { name: /^Side chats,/ })).toHaveCount(0);
      await expect(
        page.getByRole("combobox", { name: "Message Project Chat", exact: true }),
      ).toBeFocused();
      expect(errors).toEqual([]);
    } finally {
      await application.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}

for (const theme of ["dark", "light"] as const) {
  test(`Side Chat tab surfaces, overflow and terminal close targets (${theme})`, async () => {
    test.setTimeout(120_000);
    const root = await mkdtemp(join(tmpdir(), "cake-side-chat-tabs-"));
    const paths = {
      cakeHome: join(root, "cake"),
      userData: join(root, "user-data"),
      project: join(root, "project"),
    };
    await seedSideChatTabs(paths.cakeHome, paths.userData, paths.project, theme);
    const application = await electron.launch({
      args: [repositoryRoot],
      cwd: repositoryRoot,
      env: {
        ...process.env,
        CAKE_ELECTRON_SMOKE: "1",
        CAKE_ELECTRON_USER_DATA: paths.userData,
        CAKE_HOME: paths.cakeHome,
        PI_CODING_AGENT_DIR: join(paths.cakeHome, "pi"),
        PI_CODING_AGENT_SESSION_DIR: "",
      },
    });
    try {
      const page = await application.firstWindow();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const resize = (width: number) =>
        application.evaluate(
          ({ BrowserWindow }, width) =>
            BrowserWindow.getAllWindows()[0]!.setContentSize(width, 900),
          width,
        );
      await resize(1440);
      await sideChatTabsScenario.prepare(page, "default");
      const strip = page.getByRole("tablist", { name: "Side chats", exact: true });
      const tabs = strip.getByRole("tab");
      const selected = strip.getByRole("tab", { selected: true });
      const layout = page.locator('[data-slot="side-chat-layout"]');
      const pane = strip.locator("..");
      await expect(layout).toHaveAttribute("data-presentation", "side-by-side");
      const sideChat = page.getByRole("complementary", {
        name: sideChatTabTitles[0],
        exact: true,
      });
      const header = sideChat.locator(":scope > header");
      const parentInput = page.getByRole("combobox", {
        name: "Message Project Chat",
        exact: true,
      });
      const sideInput = sideChat.getByRole("combobox");
      const output = join(repositoryRoot, ".visual-captures");
      await mkdir(output, { recursive: true });
      await expect(header.getByText("Side Chat", { exact: true })).toBeVisible();
      await expect(sideChat).toHaveCSS("border-left-width", "2px");
      await parentInput.click();
      await expect(parentInput).toBeFocused();
      expect(await parentInput.evaluate((el) => el.closest(".side-chat-panel") === null)).toBe(
        true,
      );
      const restingBorder = await sideChat.evaluate((el) => getComputedStyle(el).borderColor);
      const restingHeader = await header.evaluate((el) => getComputedStyle(el).backgroundColor);
      await layout.screenshot({ path: join(output, `side-chat-main-focus-${theme}.png`) });
      await sideInput.click();
      await expect(sideInput).toBeFocused();
      await expect(sideChat).not.toHaveCSS("border-color", restingBorder);
      await expect(header).not.toHaveCSS("background-color", restingHeader);
      await layout.screenshot({ path: join(output, `side-chat-side-focus-${theme}.png`) });
      // Shift+Tab retains sequential control navigation; plain Tab is Cake's writing shortcut.
      const closePane = sideChat.getByRole("button", { name: "Close side chat", exact: true });
      await tabs.first().focus();
      await page.keyboard.press("Shift+Tab");
      await expect(closePane).toBeFocused();
      await expect(closePane).toHaveCSS("outline-style", "solid");
      await expect(closePane).toHaveCSS("outline-width", "2px");
      const merge = sideChat.getByRole("button", { name: "Merge into main chat", exact: true });
      const resolve = sideChat.getByRole("button", { name: "Close and resolve", exact: true });
      await resolve.focus();
      await page.keyboard.press("Shift+Tab");
      await expect(merge).toBeFocused();
      await expect(merge).toBeEnabled();
      await layout.screenshot({ path: join(output, `side-chat-action-focus-${theme}.png`) });
      const first = tabs.first();
      await expect(first).toHaveAttribute("title", sideChatTabTitles[0]);
      await expect(first).toHaveCSS("border-top-width", "1px");
      const activeBackground = await first.evaluate((el) => getComputedStyle(el).backgroundColor);
      await expect(tabs.nth(1)).not.toHaveCSS("background-color", activeBackground);
      await expect(first).toHaveCSS("height", "32px");
      await expect
        .poll(() => first.evaluate((el) => getComputedStyle(el, "::after").height))
        .toBe("2px");
      await expect.poll(() => strip.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
      await pane.screenshot({ path: join(output, `tabs-after-${theme}.png`) });
      const inactiveBackground = await tabs
        .nth(1)
        .evaluate((el) => getComputedStyle(el).backgroundColor);
      await tabs.nth(1).hover();
      await expect(tabs.nth(1)).not.toHaveCSS("background-color", inactiveBackground);
      await strip.screenshot({ path: join(output, `tabs-hover-${theme}.png`) });
      await first.focus();
      await page.keyboard.press("ArrowRight");
      await expect(tabs.nth(1)).toBeFocused();
      await expect(first).toHaveAttribute("aria-selected", "true");
      await expect(tabs.nth(1)).toHaveCSS("box-shadow", /inset/);
      await strip.screenshot({ path: join(output, `tabs-focus-${theme}.png`) });
      await page.keyboard.press("End");
      await expect(tabs.last()).toBeFocused();
      await expect(tabs.last()).toBeInViewport({ ratio: 1 });
      await page.keyboard.press("Enter");
      await expect(tabs.last()).toHaveAttribute("aria-selected", "true");
      const panel = page.getByRole("tabpanel");
      await expect(panel).toHaveAttribute("aria-labelledby", (await selected.getAttribute("id"))!);
      await page.mouse.move(1, 1);
      await strip.screenshot({ path: join(output, `tabs-overflow-${theme}.png`) });
      // Switching chats intentionally moves focus into that chat’s composer.
      await selected.focus();
      await page.keyboard.press("Home");
      await expect(first).toBeFocused();
      await page.keyboard.press("Space");
      await expect(first).toHaveAttribute("aria-selected", "true");
      // Resize the same real pane: screenshot-like width, narrow split, wide split, replacement.
      for (const key of ["Home", "End"]) {
        await page.getByRole("separator", { name: "Resize side chat", exact: true }).press(key);
        await expect(first).toBeInViewport({ ratio: 1 });
        await strip.screenshot({
          path: join(output, `tabs-split-${key}-${theme}.png`),
          scale: "css",
        });
      }
      await resize(640);
      await expect(layout).toHaveAttribute("data-presentation", "replacement");
      await expect(header.getByText("Side Chat", { exact: true })).toBeVisible();
      await expect(closePane).toBeVisible();
      await layout.screenshot({ path: join(output, `side-chat-replacement-${theme}.png`) });
      await expect.poll(() => strip.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
      await pane.screenshot({ path: join(output, `tabs-narrow-${theme}.png`) });
      await first.focus();
      await page.keyboard.press("End");
      await expect(tabs.last()).toBeInViewport({ ratio: 1 });
      await page.keyboard.press("Enter");
      await expect(tabs.last()).toHaveAttribute("aria-selected", "true");
      await page.getByRole("button", { name: "Close side chat", exact: true }).click();
      await expect(strip).toHaveCount(0);
      await expect(
        page.getByRole("combobox", { name: "Message Project Chat", exact: true }),
      ).toBeVisible();

      // The other genuine Cake tab surface shares chrome, not lifecycle or close handlers.
      await resize(1440);
      await application.evaluate(({ Menu }) => {
        const item = Menu.getApplicationMenu()
          ?.items.flatMap((entry) => entry.submenu?.items ?? [])
          .find((entry) => entry.label === "Toggle Terminal");
        if (!item) throw new Error("Missing terminal menu action");
        item.click({}, undefined);
      });
      const terminal = page.getByRole("tablist", { name: "Terminal tabs" });
      await expect(terminal.getByRole("tab")).toHaveCount(1);
      await expect(terminal.getByRole("tab").first()).toHaveAttribute("aria-selected", "true");
      await terminal.getByRole("button", { name: "New terminal tab", exact: true }).click();
      await expect(terminal.getByRole("tab")).toHaveCount(2);
      const activeTerminal = terminal.getByRole("tab", { selected: true });
      await expect(activeTerminal.locator("..")).toHaveCSS("border-top-width", "1px");
      await terminal.screenshot({ path: join(output, `terminal-tabs-${theme}.png`) });
      const close = terminal.getByRole("button", { name: /^Close .* tab$/ });
      await expect(close).toHaveCount(1);
      await close.click();
      await expect(terminal.getByRole("tab")).toHaveCount(1);
      await expect(terminal.getByRole("tab").first()).toHaveAttribute("aria-selected", "true");
      expect(errors).toEqual([]);
    } finally {
      await application.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}
