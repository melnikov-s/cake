import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "../../scripts/queued-electron.mjs";
import { expect, test, type Locator } from "@playwright/test";
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
    await page
      .getByRole("button", { name: /^Open Project Chat for / })
      .first()
      .click();
    const panel = page.getByRole("complementary", { name: "Workspace", exact: true });
    const toggle = panel.getByRole("button", { name: /^To-dos / });
    const openTodos = async () => {
      await page
        .getByRole("button", { name: /^Open Project Chat for / })
        .first()
        .click();
      await expect(
        page.getByRole("combobox", { name: "Message Project Chat", exact: true }),
      ).toBeVisible();
      if (!(await panel.isVisible()))
        await page.locator('[data-slot="shell-workspace-toggle"]').click();
      await toggle.click();
      await expect(panel).toBeVisible();
    };
    await openTodos();
    const row = panel.locator("[data-todo-id]");
    const action = row.getByRole("button", { name: title, exact: true });
    const focus = row.getByRole("button", { name: `Focus to-do: ${title}`, exact: true });
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
      await expect(action).toHaveAttribute("aria-expanded", "true");
      await expect(focus).toHaveAttribute("aria-pressed", "false");
      await expect(done).toBeVisible();
      await expect(toggle).toHaveText("To-dos 1");
    };
    // Observe native copy without modifying the user's system clipboard.
    await page.evaluate(() => {
      document.addEventListener("copy", (event) => {
        document.body.dataset.copiedTodo = window.getSelection()?.toString();
        event.preventDefault();
      });
    });
    await action.press("Enter");
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
    // The expanded multiline description stays selectable.
    const descriptionPoints = await textPoints(prose, description.length);
    await page.mouse.move(descriptionPoints.start.x, descriptionPoints.start.y);
    await page.mouse.down();
    await page.mouse.move(descriptionPoints.end.x, descriptionPoints.end.y, { steps: 20 });
    await page.mouse.up();
    // Chromium serializes collapsed Markdown whitespace as rendered, not as source.
    await expect
      .poll(async () => (await selectedText()).replace(/\s+/g, " "))
      .toContain(description.replace(/\s+/g, " "));
    await unchanged();
    await clearSelection();

    for (const target of [done, focus, link]) {
      const points = await textPoints(prose);
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

    const savedSelection = async () =>
      JSON.parse(await readFile(join(cakeHome, "state", "application.json"), "utf8")).data
        .projects[0].todos.selectedId;
    await focus.press("Space");
    await expect(focus).toHaveAttribute("aria-pressed", "true");
    await focus.press("Enter");
    await unchanged();
    await expect.poll(savedSelection).toBeNull();

    const reply = row.getByRole("button", { name: `Attach to-do as context: ${title}` });
    const label = row.getByRole("button", {
      name: `Change label for ${title}. Current label: Unlabelled`,
    });
    const links = row.getByRole("button", { name: `Hide 1 link for ${title}` });
    // Plain Tab returns to writing; Shift+Tab retains navigation between row controls.
    await link.focus();
    for (const control of [links, label, reply, done, focus, action]) {
      await page.keyboard.press("Shift+Tab");
      await expect(control).toBeFocused();
    }

    await focus.click();
    await done.click();
    await expect.poll(savedSelection).toBeNull();
    await expect(toggle).toHaveText("To-dos 0");
    await expect(focus).toHaveAttribute("aria-pressed", "true");
    await row.getByRole("button", { name: `Unfocus to-do: ${title}`, exact: true }).click();
    await expect(action).toHaveAttribute("aria-expanded", "true");
    const completedPoints = await textPoints(prose);
    await page.mouse.move(completedPoints.start.x, completedPoints.start.y);
    await page.mouse.down();
    await page.mouse.move(completedPoints.end.x, completedPoints.end.y, { steps: 12 });
    await page.mouse.up();
    await expect.poll(selectedText).toBe(completedPoints.text);
    await row.getByRole("button", { name: `Reopen: ${title}` }).click();
    await expect(toggle).toHaveText("To-dos 1");
    await page.reload();
    await openTodos();
    await expect(action).toHaveAttribute("aria-expanded", "false");
    await expect(focus).toHaveAttribute("aria-pressed", "false");
    await expect.poll(savedSelection).toBeNull();
  } finally {
    await app?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
