import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "../../scripts/queued-electron.mjs";
import { expect, test } from "@playwright/test";
import { defaultApplicationState } from "../../src/contracts/application/application-data";
import { emptyProjectTodos, type ProjectTodo } from "../../src/contracts/projects/project-todos";

const repository = resolve(import.meta.dirname, "../..");

test("one latest update expands inline; the existing dot and independent row actions stay in place", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cake-todo-description-"));
  const paths = {
    cakeHome: join(directory, "cake"),
    project: join(directory, "project"),
    userData: join(directory, "user-data"),
  };
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    await mkdir(paths.project);
    await mkdir(join(paths.cakeHome, "state"), { recursive: true });
    const legacyUpdate =
      "Compare cold and warm launches to identify repeated configuration reads.\n\n"
        .repeat(12)
        .trim();
    const items: ProjectTodo[] = [];
    for (let index = 15; index >= 0; index--)
      items.push({
        id: `00000000-0000-4000-8000-${String(index + 100).padStart(12, "0")}`,
        title: `Additional task ${index}`,
        description: index === 0 ? legacyUpdate : "",
        state: "open",
        status: "",
        revision: 0,
        associations: [],
      });
    const description =
      "The report-card fix [#2486609](https://example.com/pull/2486609) passed review. We just need to verify that the cards show the right source names (`ba24be3c`).";
    const renderedDescription =
      "The report-card fix #2486609 passed review. We just need to verify that the cards show the right source names (ba24be3c).";
    const label = { id: "10000000-0000-4000-8000-000000000001", name: "Research", color: "violet" };
    items.push({
      id: "00000000-0000-4000-8000-000000000011",
      title: "Fix report-card source names",
      description,
      labelId: label.id,
      state: "open",
      status: "Report ready for review.",
      revision: 0,
      associations: [
        { kind: "source", ref: "https://example.com/report", title: "Exact investigation report" },
      ],
    });
    const timestamp = "2026-01-01T00:00:00.000Z";
    await writeFile(
      join(paths.cakeHome, "state", "application.json"),
      JSON.stringify({
        version: 9,
        data: {
          ...defaultApplicationState(),
          globalSessionLabels: [...defaultApplicationState().globalSessionLabels, label],
          projects: [
            {
              path: paths.project,
              name: "Project",
              addedAt: timestamp,
              lastOpenedAt: timestamp,
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
        CAKE_ELECTRON_SMOKE: "1",
        CAKE_HOME: paths.cakeHome,
        CAKE_ELECTRON_USER_DATA: paths.userData,
        PI_CODING_AGENT_DIR: join(paths.cakeHome, "pi"),
        PI_CODING_AGENT_SESSION_DIR: "",
      },
    });
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.setViewportSize({ width: 1500, height: 900 });
    await page.getByRole("button", { name: "Open Cake Chat", exact: true }).click();
    await page
      .getByRole("button", { name: /^Open Project Chat for / })
      .first()
      .click();
    await expect(page.getByRole("combobox", { name: "Message Project Chat" })).toBeVisible();
    const panel = page.getByRole("complementary", { name: "Workspace", exact: true });
    if (!(await panel.isVisible()))
      await page.locator('[data-slot="shell-workspace-toggle"]').click();
    await panel.getByRole("button", { name: /^To-dos / }).click();
    const title = panel.getByRole("button", { name: "Fix report-card source names", exact: true });
    const row = panel.locator('[data-todo-id="00000000-0000-4000-8000-000000000011"]');
    const marker = row.locator('[data-slot="nav-trailing"]').getByRole("img", { name: "Open" });
    const dot = marker.locator("span");
    const preview = row.locator('[data-slot="todo-description"]');
    const legacyTitle = panel.getByRole("button", { name: "Additional task 0", exact: true });
    const legacyPreview = legacyTitle.locator("..").locator('[data-slot="todo-description"]');
    const isClipped = (element: Element) => element.scrollHeight > element.clientHeight;
    const report = row.getByRole("link", { name: "Exact investigation report", exact: true });
    const actions = row.locator('[data-slot="todo-actions"]');
    const focus = actions.getByRole("button", {
      name: "Focus to-do: Fix report-card source names",
      exact: true,
    });
    const done = actions.getByRole("button", { name: "Mark done: Fix report-card source names" });
    const attach = actions.getByRole("button", {
      name: "Attach to-do as context: Fix report-card source names",
    });
    const labelPicker = row.getByRole("button", { name: /Current label: Research/ });
    const dotMarkup = await marker.evaluate((element) => element.outerHTML);
    const dotPosition = async () => {
      const [bounds, origin] = await Promise.all([dot.boundingBox(), row.boundingBox()]);
      return [bounds!.x - origin!.x, bounds!.y - origin!.y, bounds!.width, bounds!.height];
    };
    const initialDot = await dotPosition();
    expect(initialDot[0]).toBeLessThan(
      (await title.boundingBox())!.x - (await row.boundingBox())!.x,
    );
    await expect(marker.locator("[data-session-label-color]")).toHaveCount(0);
    await expect(labelPicker.getByText("Research", { exact: true })).toBeVisible();
    await expect(labelPicker.locator("[data-session-label-color]")).toHaveCount(1);
    await expect(title).toHaveAttribute("aria-expanded", "false");
    await expect(preview).toHaveCount(1);
    await expect(preview).toHaveText(renderedDescription);
    await expect(preview.getByRole("link", { name: "#2486609", exact: true })).toBeVisible();
    await expect(preview.locator("code")).toHaveText("ba24be3c");
    await expect(preview).toHaveCSS("-webkit-line-clamp", "4");
    await expect.poll(() => preview.evaluate(isClipped)).toBe(false);
    await expect.poll(() => legacyPreview.evaluate(isClipped)).toBe(true);
    await legacyTitle.press("Enter");
    await expect(legacyTitle).toHaveAttribute("aria-expanded", "true");
    await expect(legacyPreview).toHaveCount(1);
    await expect(legacyPreview.locator("p")).toHaveCount(12);
    await expect.poll(() => legacyPreview.evaluate(isClipped)).toBe(false);
    await legacyTitle.press("Enter");
    await expect(legacyTitle).toHaveAttribute("aria-expanded", "false");
    await expect(report).toHaveCount(0);

    await page.getByRole("combobox", { name: "Message Project Chat" }).focus();
    await page.mouse.move(1, 1);
    await expect(focus).toHaveCSS("opacity", "0");
    const before = await row.boundingBox();
    await title.hover();
    await expect(done).toHaveCSS("opacity", "1");
    await expect(attach).toHaveCSS("opacity", "1");
    await expect(focus).toHaveCSS("opacity", "1");
    // Wait past the removed description hover delay, then check the portaled tooltip.
    await page.waitForTimeout(250);
    await expect(
      page.getByRole("tooltip").filter({ hasText: "The report-card fix passed review" }),
    ).toHaveCount(0);
    await expect(title).not.toHaveAttribute("title");
    expect(await row.boundingBox()).toEqual(before);
    await focus.hover();
    await expect(
      page.getByRole("tooltip", { name: "Focus to-do: Fix report-card source names" }),
    ).toBeVisible();

    // Click the description's prose, not its link.
    await preview.click({ position: { x: 2, y: 2 } });
    await expect(title).toHaveAttribute("aria-expanded", "true");
    await expect(title).toBeFocused();
    await expect(focus).toHaveAttribute("aria-pressed", "false");
    await expect(preview).toHaveCSS("-webkit-line-clamp", "none");
    await expect(preview.locator("p")).toHaveText(renderedDescription);
    await expect(preview).toHaveCount(1);
    await expect(row.getByText(/Report ready for review/)).toHaveCount(0);
    await expect(report).toBeVisible();
    expect(await marker.evaluate((element) => element.outerHTML)).toBe(dotMarkup);
    expect(await dotPosition()).toEqual(initialDot);

    await labelPicker.click();
    const menu = page.getByRole("menu", { name: "Choose label" });
    await expect(menu).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(title).toHaveAttribute("aria-expanded", "true");
    await expect(focus).toHaveAttribute("aria-pressed", "false");
    await title.press("Shift+F10");
    await expect(
      page.getByRole("menu", { name: "Actions for Fix report-card source names" }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(title).toHaveAttribute("aria-expanded", "true");

    await title.press("Space");
    await expect(title).toHaveAttribute("aria-expanded", "false");
    await expect(report).toHaveCount(0);
    await row
      .getByRole("button", { name: "Show 1 link for Fix report-card source names", exact: true })
      .click();
    await expect(report).toBeVisible();
    await expect(title).toHaveAttribute("aria-expanded", "false");
    await expect(preview).toHaveCSS("-webkit-line-clamp", "4");
    await row
      .getByRole("button", { name: "Hide 1 link for Fix report-card source names", exact: true })
      .click();
    await expect(report).toHaveCount(0);

    await focus.press("Enter");
    await expect(focus).toHaveAttribute("aria-pressed", "true");
    await expect(focus).toBeFocused();
    await expect(title).toHaveAttribute("aria-expanded", "false");
    await title.press("Enter");
    await expect(title).toHaveAttribute("aria-expanded", "true");
    await expect(focus).toHaveAttribute("aria-pressed", "true");
    await focus.press("Space");
    await expect(focus).toHaveAttribute("aria-pressed", "false");
    await expect(title).toHaveAttribute("aria-expanded", "true");
    expect(errors).toEqual([]);
  } finally {
    await app?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
