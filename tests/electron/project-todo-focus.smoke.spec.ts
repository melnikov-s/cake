import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { defaultApplicationState } from "../../src/contracts/application/application-data";
import { emptyProjectTodos } from "../../src/contracts/projects/project-todos";

const repository = resolve(import.meta.dirname, "../..");

for (const reducedMotion of [false, true]) {
  test(`multi-focus moves, scrolls and restores rows without changing their state (${reducedMotion ? "reduced motion" : "motion"})`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "cake-todo-focus-"));
    const project = join(directory, "project");
    const cakeHome = join(directory, "cake");
    const file = join(cakeHome, "state", "application.json");
    const id = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
    const items = Array.from({ length: 32 }, (_, index) => ({
      id: id(index),
      title: `Task ${index}`,
      description: `Findings for task ${index}.`,
      status: "",
      state: "open",
      revision: 0,
      associations: [],
      ...(index === 31 ? { needsAttention: true, attentionReason: "Review these findings" } : {}),
    }));
    let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
    try {
      await mkdir(project);
      await mkdir(join(directory, "home"));
      await mkdir(join(cakeHome, "state"), { recursive: true });
      await writeFile(
        file,
        JSON.stringify({
          version: 10,
          data: {
            ...defaultApplicationState(),
            projects: [
              {
                path: project,
                name: "Project",
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
      await page.emulateMedia({
        reducedMotion: reducedMotion ? "reduce" : "no-preference",
        colorScheme: reducedMotion ? "dark" : "light",
      });
      await page.setViewportSize({ width: 1500, height: 900 });
      await page.getByRole("button", { name: "Cake Chat", exact: true }).click();
      await page
        .getByRole("button", { name: "Open Project Chat for project", exact: true })
        .click();
      const composer = page.getByRole("combobox", { name: "Message Project Chat" });
      await expect(composer).toBeVisible();
      await page.getByRole("button", { name: "To-do", exact: true }).click();
      const panel = page.getByRole("complementary", { name: "To-do", exact: true });
      const pane = panel.locator('[data-slot="todo-scroll-pane"]');
      const action = (index: number) =>
        panel.getByRole("button", { name: `Task ${index}`, exact: true });
      const category = (name: string) =>
        panel.getByRole("list", { name: `${name} to-dos`, exact: true });
      // Observe real native animation and scroll requests without replacing their implementations.
      await page.evaluate(() => {
        const animate = Element.prototype.animate;
        Object.defineProperty(Element.prototype, "animate", {
          configurable: true,
          value: function (
            this: HTMLElement,
            frames: Keyframe[],
            options: KeyframeAnimationOptions,
          ) {
            if (
              this.hasAttribute("data-animated-list-key") ||
              this.getAttribute("aria-hidden") === "true"
            ) {
              const records = JSON.parse(document.body.dataset.todoAnimations ?? "[]");
              records.push({
                id: this.dataset.animatedListKey,
                exit: this.getAttribute("aria-hidden") === "true",
                frames,
              });
              document.body.dataset.todoAnimations = JSON.stringify(records);
            }
            return Reflect.apply(animate, this, [frames, options]);
          },
        });
        const scrollTo = Element.prototype.scrollTo;
        Object.defineProperty(Element.prototype, "scrollTo", {
          configurable: true,
          value: function (this: HTMLElement, options: ScrollToOptions) {
            if (this.dataset.slot === "todo-scroll-pane") {
              const records = JSON.parse(document.body.dataset.todoScrolls ?? "[]");
              records.push(options);
              document.body.dataset.todoScrolls = JSON.stringify(records);
            }
            return Reflect.apply(scrollTo, this, [options]);
          },
        });
      });
      await action(0).scrollIntoViewIfNeeded();
      expect(await pane.evaluate((element) => element.scrollTop)).toBeGreaterThan(200);
      await action(0).click();
      await expect(
        category("Focus").getByRole("button", { name: "Task 0", exact: true }),
      ).toBeFocused();
      await expect.poll(() => pane.evaluate((element) => element.scrollTop)).toBe(0);
      const scrolls = () =>
        page.evaluate(() => JSON.parse(document.body.dataset.todoScrolls ?? "[]"));
      expect(await scrolls()).toEqual([{ top: 0, behavior: reducedMotion ? "instant" : "smooth" }]);
      const motion = await page.evaluate(() =>
        JSON.parse(document.body.dataset.todoAnimations ?? "[]"),
      );
      if (reducedMotion) expect(motion).toEqual([]);
      else
        expect(motion).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              id: id(0),
              frames: expect.arrayContaining([
                expect.objectContaining({ translate: expect.any(String) }),
              ]),
            }),
          ]),
        );
      await action(31).click();
      await expect(category("Focus").locator("[data-todo-id]")).toHaveCount(2);
      await expect(action(0)).toHaveAttribute("aria-pressed", "true");
      await action(31).click();
      await expect(category("Focus").locator("[data-todo-id]")).toHaveCount(2);
      expect(await scrolls()).toHaveLength(2);
      // Focus is a view operation: attention and item revisions have not changed on disk.
      const saved = JSON.parse(await readFile(file, "utf8")).data.projects[0].todos;
      expect(saved.items).toEqual(items);
      await panel.getByRole("button", { name: "Unfocus to-do: Task 31" }).click();
      await expect(
        category("Needs attention").getByRole("button", { name: "Task 31", exact: true }),
      ).toBeFocused();
      await expect(action(31)).toHaveText("Review these findings");
      // Unrelated attention updates preserve scroll and the active composer, not the last focused row.
      await composer.fill("Keep this draft");
      await pane.evaluate((element) => {
        element.scrollTop = 120;
      });
      const top = await pane.evaluate((element) => element.scrollTop);
      await panel
        .getByRole("button", { name: "Dismiss attention: Task 31" })
        .evaluate((element: HTMLButtonElement) => element.click());
      await expect(
        category("Active").getByRole("button", { name: "Task 31", exact: true }),
      ).toBeVisible();
      await expect(composer).toBeFocused();
      await expect(composer).toHaveValue("Keep this draft");
      expect(await pane.evaluate((element) => element.scrollTop)).toBe(top);
      expect(await scrolls()).toHaveLength(2);
      // Filtering exercises actual removal/arrival animation while preserving typing focus.
      const search = panel.getByRole("searchbox", { name: "Search to-dos" });
      await search.fill("Task 0");
      await expect(search).toBeFocused();
      await expect(category("Focus").locator("[data-todo-id]")).toHaveCount(1);
      const afterFilter = await page.evaluate(() =>
        JSON.parse(document.body.dataset.todoAnimations ?? "[]"),
      );
      if (reducedMotion) expect(afterFilter).toEqual([]);
      else expect(afterFilter.some((record: { exit?: boolean }) => record.exit)).toBe(true);
      await search.clear();
      await expect(search).toBeFocused();
      await panel.getByRole("button", { name: "Unfocus to-do: Task 0" }).click();
      await expect(action(0)).toBeFocused();
      await expect(
        category("Active").getByRole("button", { name: "Task 0", exact: true }),
      ).toHaveAttribute("aria-pressed", "false");
      expect(
        await app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().every(
            (window) => !window.isVisible() && !window.isFocused(),
          ),
        ),
      ).toBe(true);
    } finally {
      await app?.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}
