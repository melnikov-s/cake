import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "../../scripts/queued-electron.mjs";
import { expect, test } from "@playwright/test";
import { findVisualCaptureScenario } from "../../scripts/visual-capture/scenarios";
import { showSessions, showTodos } from "./fixtures/workspace-navigation";

const repository = resolve(import.meta.dirname, "../..");

for (const theme of ["light", "dark"] as const) {
  test(`to-do associations stay compact, inspectable and navigable in ${theme} mode`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "cake-todo-links-"));
    const paths = {
      cakeHome: join(directory, "cake-home"),
      project: join(directory, "project"),
      userData: join(directory, "user-data"),
    };
    const scenario = findVisualCaptureScenario("project-chat-todos")!;
    await scenario.seed(paths, theme);
    const app = await electron.launch({
      args: [repository],
      cwd: repository,
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
      const page = await app.firstWindow();
      await page.setViewportSize({ width: 1500, height: 900 });
      await scenario.prepare(page, "open");
      const panel = page.getByRole("complementary", { name: "Workspace", exact: true });
      const startup = panel.getByRole("button", { name: "Startup investigation", exact: true });
      const navigation = panel.getByRole("button", {
        name: "Improve project navigation",
        exact: true,
      });
      const startupCue = startup.locator("..");
      const focusStartup = startupCue.getByRole("button", {
        name: "Focus to-do: Startup investigation",
        exact: true,
      });
      const focusNavigation = navigation.locator("..").getByRole("button", {
        name: "Focus to-do: Improve project navigation",
        exact: true,
      });
      const startupSession = page.locator(
        '.session-item[data-session-id="visual-assistant-markdown-code"]',
      );
      const navigationSession = page.locator(
        '.session-item[data-session-id="visual-todo-waiting"]',
      );
      await expect(startupCue).toHaveAttribute("data-associated", "true");
      // A focused to-do shows the stronger view-focus ring instead of the dashed advisory cue;
      // its linked session keeps the dashed cue (aa4992a2).
      await expect(startupCue).toHaveAttribute("data-view-focused", "true");
      await expect(startupCue).toHaveCSS("outline-style", "none");
      await expect(startupCue).not.toHaveCSS("box-shadow", "none");
      // Sessions and To-dos are exclusive Workspace tabs since chat-first navigation (582d0fc7);
      // the window-local to-do focus carries the cue into the Sessions list.
      const inSessions = async (check: () => Promise<void>) => {
        await showSessions(page);
        await check();
        await showTodos(page);
      };
      await inSessions(async () => {
        await expect(startupSession).toHaveAttribute("data-associated", "true");
        await expect(startupSession).toHaveCSS("outline-style", "dashed");
      });
      await expect(startup).not.toHaveAttribute("aria-current");
      // The scenario focused Startup through its row action; Unfocus releases the cue.
      await expect(focusStartup).toHaveAttribute("aria-pressed", "true");
      await panel
        .getByRole("button", { name: "Unfocus to-do: Startup investigation", exact: true })
        .click();
      await expect(focusStartup).toHaveAttribute("aria-pressed", "false");
      await inSessions(() => expect(startupSession).not.toHaveAttribute("data-associated"));
      await focusNavigation.click();
      await inSessions(async () => {
        await expect(startupSession).not.toHaveAttribute("data-associated");
        await expect(navigationSession).toHaveAttribute("data-associated", "true");
      });
      await focusStartup.click();
      await expect(focusStartup).toHaveAttribute("aria-pressed", "true");
      await showSessions(page);
      await expect(startupSession).toHaveAttribute("data-associated", "true");
      await expect(navigationSession).not.toHaveAttribute("data-associated", "true");
      // Hover keeps the dashed advisory cue (the shared hover layer left with 582d0fc7).
      await startupSession.locator(".session-row").hover();
      await expect(startupSession).toHaveCSS("outline-style", "dashed");
      await page.mouse.move(1, 1);
      await showTodos(page);
      await panel
        .getByRole("button", { name: "Show 6 links for Startup investigation", exact: true })
        .click();
      const destinations = [
        ["Startup investigation session", "cake://session/visual-assistant-markdown-code"],
        [
          "Exact investigation report",
          "cake://session/visual-assistant-markdown-code?message=assistant-1",
        ],
        ["Startup reference website", "https://example.com/startup"],
        ["Startup findings artifact", "cake://artifact/visual-todo-report"],
        ["Investigation notes", "README.md"],
        ["Startup implementation", "startup.ts#L1"],
      ];
      // Session links name their label, the session title and the reference; every link's
      // description and tooltip end with its destination (5c284c46).
      const endsWith = (href: string) =>
        new RegExp(`${href.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
      const icons: string[] = [];
      for (const [title, href] of destinations) {
        const link = panel.getByRole("link", { name: title, exact: true });
        await expect(link).toHaveAttribute("href", href);
        await expect(link.locator(":scope > svg")).toBeHidden();
        await expect(link).toHaveAccessibleDescription(endsWith(href!));
        await expect(link).toHaveCSS("font-size", "14px");
        await expect(link).toHaveCSS("font-weight", "400");
        await expect(link).toHaveCSS("line-height", "16px");
        await expect(link).toHaveCSS("text-decoration-line", "none");
        // The kind glyph sits in its own wrapper beside the activity dot (06aa318f).
        const icon = link.locator("xpath=../..").locator(":scope > span:first-child > span:last-child svg");
        await expect(icon).toHaveAttribute("aria-hidden", "true");
        await expect(icon).toBeVisible();
        await expect(icon).toHaveCSS("width", "12px");
        await expect(icon).toHaveCSS("height", "12px");
        icons.push(await icon.innerHTML());
        await link.hover();
        await expect(page.getByRole("tooltip")).toHaveText(endsWith(href!));
        await expect(link).toHaveCSS("text-decoration-line", "underline");
        await page.mouse.move(1, 1);
        await expect(page.getByRole("tooltip")).not.toBeAttached();
      }
      // The session and its message link share the session's purpose glyph (b6cd0f2d); the
      // website, artifact and file kinds each keep a distinct glyph.
      expect(icons[1]).toBe(icons[0]);
      expect(new Set(icons.slice(1, 5)).size).toBe(4);
      // Modified Tab retains native sequential navigation; plain Tab returns to writing.
      // Start from the next row's disclosure and walk back across the Active header with Shift+Tab.
      const hideLinks = panel.getByRole("button", {
        name: "Hide 6 links for Startup investigation",
        exact: true,
      });
      await navigation.click();
      await expect(navigation).toBeFocused();
      await page.keyboard.press("Shift");
      await page.keyboard.press("Shift+Tab");
      await expect(panel.getByRole("button", { name: "Active (1)", exact: true })).toBeFocused();
      await page.keyboard.press("Shift+Tab");
      for (const [index, [title, href]] of [...destinations].reverse().entries()) {
        if (index > 0) await page.keyboard.press("Shift+Tab");
        const link = panel.getByRole("link", { name: title, exact: true });
        await expect(link).toBeFocused();
        await expect(page.getByRole("tooltip")).toHaveText(endsWith(href!));
        await expect(link).toHaveCSS("outline-style", "solid");
      }
      await page.keyboard.press("Shift+Tab");
      await expect(hideLinks).toBeFocused();
      await page.keyboard.press("Shift+Tab");
      await expect(
        panel.getByRole("button", { name: /^Change label for Startup investigation\./ }),
      ).toBeFocused();
      await page.keyboard.press("Shift+Tab");
      await expect(
        panel.getByRole("button", { name: "Unfocus to-do: Startup investigation", exact: true }),
      ).toBeFocused();
      await page.keyboard.press("Shift+Tab");
      await expect(
        panel.getByRole("button", {
          name: "Attach to-do as context: Startup investigation",
          exact: true,
        }),
      ).toBeFocused();
      await page.keyboard.press("Shift+Tab");
      await expect(
        panel.getByRole("button", { name: "Mark done: Startup investigation", exact: true }),
      ).toBeFocused();
      await page.keyboard.press("Shift+Tab");
      await expect(focusStartup).toBeFocused();
      await page.keyboard.press("Shift+Tab");
      await expect(startup).toBeFocused();
      await page.setViewportSize({ width: 780, height: 800 });
      await expect(panel).toBeVisible();
      await expect(panel.getByRole("link", { name: "Startup implementation" })).toBeVisible();
      await panel.getByRole("link", { name: "Exact investigation report", exact: true }).click();
      await expect(
        page.locator('[data-slot="transcript-item"][aria-current="true"]'),
      ).toContainText("Repository-owned visual checks");
      await showSessions(page);
      // Navigation selection wins over the advisory cue without clearing the to-do context.
      await expect(startupSession).toHaveAttribute("data-navigation-active", "true");
      await expect(startupSession).not.toHaveAttribute("data-associated");
      await expect(startupSession).toHaveCSS("outline-style", "none");
      await expect(startupSession.locator(".session-row > button")).toHaveAttribute(
        "aria-current",
        "page",
      );
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}
