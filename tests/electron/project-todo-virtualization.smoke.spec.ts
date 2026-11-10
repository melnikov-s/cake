import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "../../scripts/queued-electron.mjs";
import { expect, test } from "@playwright/test";
import { defaultApplicationState } from "../../src/contracts/application/application-data";
import { emptyProjectTodos, type ProjectTodo } from "../../src/contracts/projects/project-todos";

const repository = resolve(import.meta.dirname, "../..");

for (const theme of ["light", "dark"] as const) {
  test(`one measured To-dos scrollport bounds maximum persisted history and preserves navigation (${theme})`, async ({}, info) => {
    test.setTimeout(90_000);
    const directory = await mkdtemp(join(tmpdir(), "cake-todo-virtualization-"));
    const project = join(directory, "project");
    const cakeHome = join(directory, "cake");
    const file = join(cakeHome, "state", "application.json");
    // Persistence currently caps a list at 1000 items. The renderer-only regression
    // separately exercises 5000 Done items without changing that domain contract.
    const items: ProjectTodo[] = Array.from({ length: 1000 }, (_, index) => ({
      id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      title:
        index < 2
          ? `Active task ${index}`
          : `Completed task ${index}${index % 3 === 0 ? " — investigate variable-height history with a longer finding that wraps across several lines" : ""}`,
      description: `Detailed findings for task ${index}. Descriptions remain available on hover.`,
      status: "",
      state: index < 2 ? "open" : "done",
      revision: 0,
      associations: [],
    }));
    let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
    try {
      await mkdir(project);
      await mkdir(join(cakeHome, "state"), { recursive: true });
      await mkdir(join(directory, "home"));
      await writeFile(
        file,
        JSON.stringify({
          version: 10,
          data: {
            ...defaultApplicationState(),
            projects: [
              {
                path: project,
                name: "Virtualized history",
                addedAt: "2026-01-01T00:00:00.000Z",
                lastOpenedAt: "2026-01-01T00:00:00.000Z",
                todos: { ...emptyProjectTodos(), items },
              },
            ],
          },
        }),
      );
      app = await electron.launch({
        args: [repository],
        cwd: repository,
        env: {
          ...process.env,
          HOME: join(directory, "home"),
          CAKE_ELECTRON_SMOKE: "1",
          CAKE_HOME: cakeHome,
          CAKE_ELECTRON_USER_DATA: join(directory, "user-data"),
          PI_CODING_AGENT_DIR: join(cakeHome, "pi"),
          PI_CODING_AGENT_SESSION_DIR: "",
        },
      });
      const page = await app.firstWindow();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.setViewportSize({ width: 1500, height: 900 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page
        .getByRole("button", { name: /^Open Project Chat for / })
        .first()
        .click();
      const panel = page.getByRole("complementary", { name: "Workspace", exact: true });
      if (!(await panel.isVisible()))
        await page.locator('[data-slot="shell-workspace-toggle"]').click();
      await panel.getByRole("button", { name: /^To-dos / }).click();
      const pane = panel.locator('[data-slot="todo-scroll-pane"]');
      const done = panel.getByRole("button", { name: "Done (998)", exact: true });
      await expect(done).toHaveAttribute("aria-expanded", "false");
      await expect(pane.locator('[data-todo-section="Done"]')).toHaveCount(0);
      await done.press("Enter");
      await expect(done).toHaveAttribute("aria-expanded", "true");
      const metrics = () =>
        pane.evaluate((element) => ({
          mounted: element.querySelectorAll("[data-todo-id]").length,
          scrollTop: element.scrollTop,
          scrollHeight: element.scrollHeight,
          height: element.clientHeight,
          nestedScrollports: Array.from(element.querySelectorAll<HTMLElement>("*")).filter(
            (child) =>
              /auto|scroll/.test(getComputedStyle(child).overflowY) &&
              child.scrollHeight > child.clientHeight,
          ).length,
          heights: Array.from(
            element.querySelectorAll("[data-todo-id]"),
            (row) => row.getBoundingClientRect().height,
          ),
        }));
      await expect.poll(async () => (await metrics()).mounted).toBeGreaterThan(4);
      expect((await metrics()).mounted).toBeLessThan(60);
      expect((await metrics()).nestedScrollports).toBe(0);
      expect((await metrics()).scrollHeight).toBeGreaterThan(40_000);
      expect(new Set((await metrics()).heights).size).toBeGreaterThan(1);
      await page.screenshot({ path: info.outputPath(`expanded-done-${theme}.png`) });
      const opening = await metrics();
      await done.press("Space");
      await expect(done).toHaveAttribute("aria-expanded", "false");
      await expect(pane.locator('[data-todo-section="Done"]')).toHaveCount(0);
      expect((await metrics()).scrollTop).toBe(0);
      await done.press("Space");
      await expect(done).toHaveAttribute("aria-expanded", "true");
      await expect.poll(async () => (await metrics()).mounted).toBeGreaterThan(4);

      // Move the ONE pane through unmounted history, then exercise a real mutation above
      // the reading anchor. The surviving row must retain its viewport offset.
      await pane.evaluate((element) => {
        element.scrollTop = element.scrollHeight * 0.55;
      });
      const readingAnchor = () =>
        pane.evaluate((element) => {
          const top = element.getBoundingClientRect().top;
          const row = Array.from(element.querySelectorAll<HTMLElement>("[data-todo-id]")).find(
            (row) =>
              row.getBoundingClientRect().top >= top &&
              row.getBoundingClientRect().top < top + element.clientHeight,
          );
          return row
            ? { id: row.dataset.todoId!, offset: row.getBoundingClientRect().top - top }
            : null;
        });
      await expect.poll(async () => (await metrics()).scrollTop).toBeGreaterThan(10_000);
      await expect.poll(readingAnchor).not.toBeNull();
      const anchor = (await readingAnchor())!;
      const anchorOffset = () =>
        pane
          .locator(`[data-todo-id="${anchor.id}"]`)
          .evaluate(
            (row) =>
              row.getBoundingClientRect().top -
              row.closest('[data-slot="todo-scroll-pane"]')!.getBoundingClientRect().top,
          );
      const priorId = await pane.evaluate((element) => {
        const top = element.getBoundingClientRect().top;
        const row = Array.from(element.querySelectorAll<HTMLElement>("[data-todo-id]")).find(
          (row) => row.getBoundingClientRect().bottom < top,
        )!;
        row.querySelector<HTMLButtonElement>('button[aria-label^="Reopen:"]')!.click();
        return row.dataset.todoId!;
      });
      await expect
        .poll(
          async () =>
            JSON.parse(await readFile(file, "utf8")).data.projects[0].todos.items.find(
              (item: ProjectTodo) => item.id === priorId,
            ).state,
        )
        .toBe("open");
      await expect
        .poll(async () => Math.abs((await anchorOffset()) - anchor.offset))
        .toBeLessThan(3);
      expect((await metrics()).mounted).toBeLessThan(60);

      // Changing the actual accessory width remeasures wrapped rows, not a mocked size.
      const resize = page.getByRole("separator", { name: "Resize Workspace", exact: true });
      const beforeWidth = await pane.evaluate((element) => element.clientWidth);
      const probe = await pane.evaluate((element) => {
        const row = Array.from(element.querySelectorAll<HTMLElement>("[data-todo-id]")).find(
          (row) => row.getBoundingClientRect().height > 60,
        )!;
        return { id: row.dataset.todoId!, height: row.getBoundingClientRect().height };
      });
      await resize.focus();
      for (let index = 0; index < 10; index++) await resize.press("ArrowLeft");
      await expect
        .poll(() => pane.evaluate((element) => element.clientWidth))
        .toBeGreaterThan(beforeWidth);
      await expect
        .poll(() =>
          pane
            .locator(`[data-todo-id="${probe.id}"]`)
            .evaluate((row) => row.getBoundingClientRect().height),
        )
        .not.toBe(probe.height);
      await expect
        .poll(async () => Math.abs((await anchorOffset()) - anchor.offset))
        .toBeLessThan(3);
      await page.screenshot({ path: info.outputPath(`large-history-${theme}.png`) });
      const middle = await metrics();

      // Shift+Tab crosses an unmounted boundary in logical order. Plain Tab
      // retains Cake's existing return-to-writing shortcut.
      const firstId = await pane.evaluate(
        (element) =>
          Array.from(
            element.querySelectorAll<HTMLElement>('[data-todo-id][data-todo-section="Done"]'),
          )
            .filter((row) => row.getBoundingClientRect().height > 0)
            .sort(
              (a, b) =>
                Number(a.getAttribute("aria-posinset")) - Number(b.getAttribute("aria-posinset")),
            )[0]!.dataset.todoId!,
      );
      const first = pane.locator(`[data-todo-id="${firstId}"]`);
      const position = Number(await first.getAttribute("aria-posinset"));
      const firstAction = first.locator("button[aria-pressed]");
      await firstAction.focus();
      await expect(firstAction).toBeFocused();
      await firstAction.press("Shift+Tab");
      await expect
        .poll(() =>
          page.evaluate(() =>
            document.activeElement?.closest("[data-todo-id]")?.getAttribute("aria-posinset"),
          ),
        )
        .toBe(String(position - 1));
      expect((await metrics()).mounted).toBeLessThan(60);

      // Explicit title focus moves an offscreen historical item into Focus and restores
      // keyboard ownership there; unfocus materializes its original section again.
      const selectedId = await page.evaluate(
        () => document.activeElement!.closest<HTMLElement>("[data-todo-id]")!.dataset.todoId!,
      );
      const selectedRow = pane.locator(`[data-todo-id="${selectedId}"]`);
      const title = selectedRow.locator("button[aria-pressed]");
      await page.keyboard.press("Tab");
      await expect(page.getByRole("combobox", { name: "Message Project Chat" })).toBeFocused();
      await title.press("Space");
      await expect(title).toHaveAttribute("aria-pressed", "true");
      await expect(title).toBeFocused();
      await expect.poll(async () => (await metrics()).scrollTop).toBe(0);
      await selectedRow.getByRole("button", { name: /^Unfocus to-do:/ }).click();
      await expect(title).toHaveAttribute("aria-pressed", "false");
      await expect(title).toBeFocused();
      await expect(selectedRow).toHaveAttribute("data-todo-section", "Done");
      await title.hover();
      await expect(
        page.getByRole("tooltip").filter({ hasText: "Detailed findings for task" }),
      ).toBeVisible();
      expect(errors).toEqual([]);
      await writeFile(
        info.outputPath("virtualization-metrics.json"),
        JSON.stringify({ opening, middle, anchor, final: await metrics() }, null, 2),
      );
    } finally {
      await app?.close();
      const log = await readFile(join(cakeHome, "logs", "desktop.log"), "utf8").catch(
        () => "No desktop log",
      );
      await writeFile(info.outputPath("desktop.log"), log);
      await rm(directory, { recursive: true, force: true });
    }
  });
}
