import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "../../scripts/queued-electron.mjs";
import { expect, test } from "@playwright/test";
import { defaultApplicationState } from "../../src/contracts/application/application-data";
import { emptyProjectTodos, type ProjectTodo } from "../../src/contracts/projects/project-todos";

const repository = resolve(import.meta.dirname, "../..");

test("to-do descriptions float left or vertically inside available Cake space without moving rows", async () => {
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
    const items: ProjectTodo[] = [];
    for (let index = 15; index >= 0; index--)
      items.push({
        id: `00000000-0000-4000-8000-${String(index + 100).padStart(12, "0")}`,
        title: `Additional task ${index}`,
        description:
          index === 15 ? "Long description for review.\n".repeat(60).trim() : "Short update.",
        state: "open",
        status: "",
        revision: 0,
        associations: [],
      });
    items.push({
      id: "00000000-0000-4000-8000-000000000011",
      title: "Startup investigation",
      description: "Find the startup bottleneck and recommend a focused fix.",
      state: "open",
      status: "",
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
    await page.getByRole("button", { name: "Cake Chat", exact: true }).click();
    await page
      .getByRole("button", { name: /^Open Project Chat for / })
      .first()
      .click();
    await expect(page.getByRole("combobox", { name: "Message Project Chat" })).toBeVisible();
    const panel = page.getByRole("complementary", { name: "Workspace", exact: true });
    if (!(await panel.isVisible()))
      await page.locator('[data-slot="shell-workspace-toggle"]').click();
    await panel.getByRole("button", { name: /^To-dos / }).click();
    const title = panel.getByRole("button", { name: "Startup investigation", exact: true });
    const row = panel.locator('[data-todo-id="00000000-0000-4000-8000-000000000011"]');
    const bubble = page.getByRole("tooltip").filter({ hasText: "Find the startup bottleneck" });
    const attach = row.getByRole("button", {
      name: "Attach to-do as context: Startup investigation",
      exact: true,
    });
    await page.getByRole("combobox", { name: "Message Project Chat" }).focus();
    await page.mouse.move(1, 1);
    await expect(bubble).toHaveCount(0);
    await expect(attach).toHaveCSS("opacity", "0");
    await expect(panel.getByText("Auto-merge", { exact: true })).toHaveCount(0);
    await expect(panel.getByRole("button", { name: /auto.merge/i })).toHaveCount(0);
    await expect(
      row.getByRole("link", { name: "Exact investigation report", exact: true }),
    ).toBeVisible();
    const before = await row.boundingBox();
    await title.hover();
    await expect(bubble).toBeVisible();
    await expect(attach).toHaveCSS("opacity", "1");
    const attachBox = (await attach.boundingBox())!;
    expect(Math.abs(before!.x + before!.width - attachBox.x - attachBox.width - 32)).toBeLessThan(
      0.1,
    );
    const otherAttach = panel.getByRole("button", {
      name: "Attach to-do as context: Additional task 0",
      exact: true,
    });
    expect((await otherAttach.boundingBox())!.x).toBe(attachBox.x);
    expect(await row.boundingBox()).toEqual(before);
    expect((await bubble.boundingBox())!.x + (await bubble.boundingBox())!.width).toBeLessThan(
      before!.x,
    );
    await expect(bubble.getByRole("link")).toHaveCount(0);
    await bubble.hover();
    await expect(bubble).toBeVisible();
    await title.focus();
    await expect(title).toBeFocused();
    await title.press("Escape");
    await expect(bubble).toHaveCount(0);
    await expect(title).toBeFocused();

    // Native editor/browser surfaces cannot be overlaid. Their companion marks this boundary.
    await panel.evaluate((element) => element.setAttribute("data-popover-boundary", ""));
    for (const width of [1500, 900]) {
      await page.setViewportSize({ width, height: 900 });
      await page.mouse.move(1, 1);
      await title.hover();
      await expect(bubble).toBeVisible();
      await expect(async () => {
        const pane = (await panel.boundingBox())!;
        const target = (await row.boundingBox())!;
        const box = (await bubble.boundingBox())!;
        expect(box.x).toBeGreaterThanOrEqual(pane.x);
        expect(box.x + box.width).toBeLessThanOrEqual(pane.x + pane.width);
        expect(box.y).toBeGreaterThanOrEqual(target.y + target.height);
        expect(box.y + box.height).toBeLessThanOrEqual(pane.y + pane.height);
      }).toPass();
      await title.press("Escape");
    }
    const last = panel.getByRole("button", { name: "Additional task 15", exact: true });
    await last.hover();
    const longBubble = page
      .getByRole("tooltip")
      .filter({ hasText: "Long description for review." });
    await expect(longBubble).toBeVisible();
    const target = (await last.locator("..").boundingBox())!;
    const box = (await longBubble.boundingBox())!;
    expect(box.y + box.height).toBeLessThanOrEqual(target.y);
    expect(box.y).toBeGreaterThanOrEqual((await panel.boundingBox())!.y);
    expect(
      await longBubble.evaluate((element) => element.scrollHeight > element.clientHeight),
    ).toBe(true);
    await longBubble.focus();
    await longBubble.press("End");
    await expect.poll(() => longBubble.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    await longBubble.press("Escape");
    await expect(longBubble).toHaveCount(0);
    await expect(last).toBeFocused();
    expect(errors).toEqual([]);
  } finally {
    await app?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
