import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test, type Locator } from "@playwright/test";
import { defaultApplicationState } from "../../src/contracts/application/application-data";
import { emptyProjectTodos } from "../../src/contracts/projects/project-todos";

const repository = resolve(import.meta.dirname, "../..");

test("to-do text selection and copying do not activate rows or their controls", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cake-todo-selection-"));
  const project = join(directory, "project");
  const cakeHome = join(directory, "cake");
  const title = "Package Cake for macOS without an Apple account";
  const description =
    "Apple Silicon download is ready for review.\nRelease and first-launch checks remain pending.";
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    await mkdir(project);
    await mkdir(join(cakeHome, "state"), { recursive: true });
    await mkdir(join(directory, "home"));
    const timestamp = "2026-01-01T00:00:00.000Z";
    await writeFile(
      join(cakeHome, "state", "application.json"),
      JSON.stringify({
        version: 9,
        data: {
          ...defaultApplicationState(),
          projects: [
            {
              path: project,
              name: "Project",
              addedAt: timestamp,
              lastOpenedAt: timestamp,
              todos: {
                ...emptyProjectTodos(),
                items: [
                  {
                    id: "00000000-0000-4000-8000-000000000011",
                    title,
                    description,
                    status: "",
                    state: "open",
                    revision: 0,
                    associations: [
                      {
                        kind: "source",
                        ref: "https://example.com/release",
                        title: "Release details",
                      },
                    ],
                  },
                ],
              },
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
    await page.setViewportSize({ width: 1500, height: 900 });
    await page.getByRole("button", { name: "Cake Chat", exact: true }).click();
    await page.locator('[data-slot="project-header"] [data-slot="project-label"]').first().click();
    const toggle = page.getByRole("button", { name: "To-do", exact: true });
    await toggle.click();
    const panel = page.getByRole("complementary", { name: "To-do", exact: true });
    const row = panel.locator("[data-todo-id]");
    const action = row.getByRole("button", { name: title, exact: true });
    const prose = row.getByText(description, { exact: true });
    const done = row.getByRole("button", { name: `Mark done: ${title}` });
    const link = row.getByRole("link", { name: "Release details" });
    const selectedText = () => page.evaluate(() => window.getSelection()?.toString());
    const clearSelection = () => page.evaluate(() => window.getSelection()?.removeAllRanges());
    const textPoints = (target: Locator, endOffset = 6) =>
      target.evaluate((element, offset) => {
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        const node = walker.nextNode();
        if (!node?.textContent) throw new Error("Missing to-do text");
        const range = document.createRange();
        range.setStart(node, 0);
        range.setEnd(node, 1);
        const start = range.getBoundingClientRect();
        range.setStart(node, offset - 1);
        range.setEnd(node, offset);
        const end = range.getBoundingClientRect();
        return {
          start: { x: start.left, y: start.top + start.height / 2 },
          end: { x: end.right, y: end.top + end.height / 2 },
          text: node.textContent.slice(0, offset),
        };
      }, endOffset);
    const unchanged = async () => {
      await expect(action).toHaveAttribute("aria-pressed", "false");
      await expect(done).toBeVisible();
      await expect(panel).toBeVisible();
      await expect(toggle).toHaveText("1");
    };
    // Observe the native copy event without modifying the user's system clipboard.
    await page.evaluate(() => {
      document.addEventListener("copy", (event) => {
        document.body.dataset.copiedTodo = window.getSelection()?.toString();
        event.preventDefault();
      });
    });
    for (const target of [action, prose]) {
      const points = await textPoints(target);
      await page.mouse.move(points.start.x, points.start.y);
      await page.mouse.down();
      await page.mouse.move(points.end.x, points.end.y, { steps: 12 });
      await page.mouse.up();
      await expect.poll(selectedText).toBe(points.text);
      await unchanged();
      await page.keyboard.press(process.platform === "darwin" ? "Meta+c" : "Control+c");
      await expect(page.locator("body")).toHaveAttribute("data-copied-todo", points.text);
      await page.keyboard.down("Shift");
      await page.mouse.click(points.end.x + 20, points.end.y);
      await page.keyboard.up("Shift");
      await expect.poll(selectedText).not.toBe(points.text);
      await unchanged();
      await clearSelection();
    }
    // Selection can span the title and the full multiline description.
    const titlePoints = await textPoints(action);
    const descriptionPoints = await textPoints(prose, description.length);
    await page.mouse.move(titlePoints.start.x, titlePoints.start.y);
    await page.mouse.down();
    await page.mouse.move(descriptionPoints.end.x, descriptionPoints.end.y, { steps: 20 });
    await page.mouse.up();
    await expect.poll(selectedText).toContain(title);
    await expect.poll(selectedText).toContain(description);
    await unchanged();
    await clearSelection();
    const points = await textPoints(prose);
    // A selection drag ending over another control must not activate it.
    for (const target of [done, link]) {
      const box = await target.boundingBox();
      if (!box) throw new Error("Missing control bounds");
      await page.mouse.move(points.start.x, points.start.y);
      await page.mouse.down();
      await page.mouse.move(points.end.x, points.end.y, { steps: 12 });
      await expect.poll(selectedText).toBe(points.text);
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 12 });
      await page.mouse.up();
      await unchanged();
      await clearSelection();
    }
    // Intentional clicks and native keyboard activation retain their semantics.
    await prose.click();
    await expect(action).toBeFocused();
    await expect(action).toHaveAttribute("aria-pressed", "true");
    await action.press("Space");
    await expect(action).toHaveAttribute("aria-pressed", "false");
    await row.click({ position: { x: 8, y: 8 } });
    await expect(action).toHaveAttribute("aria-pressed", "true");
    await action.press("Enter");
    await expect(action).toHaveAttribute("aria-pressed", "false");
    await action.press("Tab");
    await expect(done).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(link).toBeFocused();
    await done.click();
    await expect(toggle).toHaveText("0");
    await panel.getByRole("button", { name: "Done (1)" }).click();
    await expect(action).toHaveAttribute("aria-disabled", "true");
    const completedPoints = await textPoints(prose);
    await page.mouse.move(completedPoints.start.x, completedPoints.start.y);
    await page.mouse.down();
    await page.mouse.move(completedPoints.end.x, completedPoints.end.y, { steps: 12 });
    await page.mouse.up();
    await expect.poll(selectedText).toBe(completedPoints.text);
    await row.getByRole("button", { name: `Reopen: ${title}` }).click();
    await expect(toggle).toHaveText("1");
  } finally {
    await app?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
