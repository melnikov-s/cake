import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { findVisualCaptureScenario } from "../../scripts/visual-capture/scenarios";

const repository = resolve(import.meta.dirname, "../..");

for (const theme of ["light", "dark"] as const) {
  test(`to-do header search filters and clears without losing selection in ${theme} mode`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "cake-todo-search-"));
    const paths = {
      cakeHome: join(directory, "cake"),
      project: join(directory, "project"),
      userData: join(directory, "user-data"),
    };
    const scenario = findVisualCaptureScenario("project-chat-todos")!;
    let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
    let dispose: void | (() => Promise<void>) = undefined;
    try {
      dispose = await scenario.seed(paths, theme);
      app = await electron.launch({
        args: [repository],
        cwd: repository,
        env: {
          ...process.env,
          CAKE_ELECTRON_SMOKE: "1",
          CAKE_HOME: paths.cakeHome,
          CAKE_ELECTRON_USER_DATA: paths.userData,
          PI_CODING_AGENT_DIR: join(paths.cakeHome, "pi"),
          PI_CODING_AGENT_SESSION_DIR: "",
        },
      });
      const page = await app.firstWindow();
      await page.setViewportSize({ width: 1500, height: 900 });
      await page.emulateMedia({ colorScheme: theme });
      await scenario.prepare(page, "open", app);
      const panel = page.getByRole("complementary", { name: "To-do", exact: true });
      const search = panel.getByRole("searchbox", { name: "Search to-dos" });
      const selected = panel.getByRole("button", { name: "Startup investigation", exact: true });
      const clear = panel.getByRole("button", { name: "Clear search to-dos" });

      const sort = panel.getByRole("combobox", { name: "Sort to-dos" });
      const rows = panel.getByRole("list", { name: "Open to-dos" }).locator(":scope > li");
      const ids = () =>
        rows.evaluateAll((elements) =>
          elements.map((element) => element.getAttribute("data-todo-id")),
        );
      const chronological = await ids();
      await sort.selectOption("latest");
      expect(await ids()).toEqual([...chronological].reverse());
      await expect(selected).toHaveAttribute("aria-pressed", "true");
      await sort.selectOption("earliest");
      expect(await ids()).toEqual(chronological);
      await panel.getByRole("button", { name: "Close To-do" }).click();
      await page.getByRole("button", { name: "To-do", exact: true }).click();
      await expect(sort).toHaveValue("earliest");
      await sort.selectOption("agent");
      expect(await ids()).toEqual(chronological);
      // Closing clears selection by design; re-establish it before the search workflow.
      await selected.click();
      await expect(selected).toHaveAttribute("aria-pressed", "true");

      for (const width of [1500, 780]) {
        await page.setViewportSize({ width, height: 900 });
        await expect(search).toBeVisible();
        const header = panel.locator("header");
        const searchBox = await search.boundingBox();
        const headerBox = await header.boundingBox();
        const closeBox = await panel.getByRole("button", { name: "Close To-do" }).boundingBox();
        expect(searchBox!.x).toBeGreaterThanOrEqual(headerBox!.x);
        expect(searchBox!.y).toBeGreaterThanOrEqual(headerBox!.y);
        expect(searchBox!.y + searchBox!.height).toBeLessThanOrEqual(
          headerBox!.y + headerBox!.height,
        );
        expect(searchBox!.x + searchBox!.width).toBeLessThanOrEqual(closeBox!.x);
        expect(await header.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
          true,
        );

        await search.click();
        await expect(search).toBeFocused();
        await search.pressSequentially("CONVERSATIONS");
        await expect(search).toHaveValue("CONVERSATIONS");
        await expect(
          panel.getByRole("button", { name: "Improve project navigation", exact: true }),
        ).toBeVisible();
        await expect(selected).toHaveCount(0);
        await search.press("Escape");
        await expect(search).toHaveValue("");
        await expect(search).toBeFocused();
        await expect(selected).toHaveAttribute("aria-pressed", "true");

        await search.pressSequentially("STARTUP");
        await expect(selected).toBeVisible();
        await search.press("Tab");
        await expect(clear).toBeFocused();
        await clear.press("Enter");
        await expect(search).toBeFocused();
        await expect(search).toHaveValue("");

        await search.pressSequentially("not a real task");
        await expect(panel.getByRole("status")).toContainText("No matching to-dos");
        await clear.click();
        await expect(selected).toHaveAttribute("aria-pressed", "true");

        await search.pressSequentially("PRIORITIES");
        await expect(panel.getByRole("status")).toHaveText("No matching open to-dos.");
        const done = panel.getByRole("button", { name: "Done (1)" });
        await expect(done).toBeVisible();
        if ((await done.getAttribute("aria-expanded")) !== "true") await done.click();
        await expect(
          panel.getByRole("button", { name: "Reopen: Discuss the next milestone" }),
        ).toBeVisible();
        await clear.click();
        await expect(selected).toHaveAttribute("aria-pressed", "true");
        await expect(done).toHaveAttribute("aria-expanded", "true");
      }
    } finally {
      await app?.close();
      await dispose?.();
      await rm(directory, { recursive: true, force: true });
    }
  });
}
