import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { cakeWorkspaceSessionDirectory } from "../../src/services/pi/runtime/session-discovery";
import { windowState } from "../fixtures/window-state";

const repositoryRoot = resolve(import.meta.dirname, "../..");

test("sidebar highlights do not reserve scroll space after their rows collapse", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "cake-sidebar-scroll-layout-"));
  const userData = join(temporaryRoot, "user-data");
  const project = join(temporaryRoot, "project");
  const cakeHome = join(temporaryRoot, "cake-home");
  const sessionDirectory = cakeWorkspaceSessionDirectory(project, join(cakeHome, "pi", "sessions"));
  const ids = Array.from({ length: 10 }, (_, index) => `scroll-session-${index}`);
  await Promise.all([
    mkdir(userData, { recursive: true }),
    mkdir(project, { recursive: true }),
    mkdir(sessionDirectory, { recursive: true }),
    mkdir(join(cakeHome, "state"), { recursive: true }),
  ]);
  await writeFile(
    join(userData, "window-state.json"),
    windowState({ project, sessionId: ids[0], theme: "dark" }),
  );
  await writeFile(
    join(cakeHome, "state", "application.json"),
    JSON.stringify({
      schemaVersion: 1,
      projects: [
        {
          path: project,
          name: "project",
          addedAt: new Date(0).toISOString(),
          lastOpenedAt: new Date(0).toISOString(),
        },
      ],
      trustedProjectPaths: [],
    }),
  );
  for (const [index, id] of ids.entries()) {
    const timestamp = new Date(Date.UTC(2020, 0, 10 - index)).toISOString();
    await writeFile(
      join(sessionDirectory, `${timestamp.replaceAll(":", "-").replace(".", "-")}_${id}.jsonl`),
      [
        { type: "session", version: 3, id, timestamp, cwd: project },
        {
          type: "message",
          id: `user-${id}`,
          parentId: null,
          timestamp,
          message: {
            role: "user",
            content: [{ type: "text", text: id }],
            timestamp: Date.parse(timestamp),
          },
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
    );
  }
  const application = await electron.launch({
    args: [repositoryRoot],
    cwd: repositoryRoot,
    env: {
      ...process.env,
      CAKE_ELECTRON_SMOKE: "1",
      CAKE_ELECTRON_USER_DATA: userData,
      CAKE_HOME: cakeHome,
      PI_CODING_AGENT_DIR: join(cakeHome, "pi"),
      PI_CODING_AGENT_SESSION_DIR: "",
    },
  });
  try {
    const page = await application.firstWindow();
    await expect(page.getByLabel("Message")).toBeVisible({ timeout: 20_000 });
    await page.setViewportSize({ width: 1100, height: 480 });
    const sidebar = page.locator('[data-slot="sidebar"]');
    const content = sidebar.locator('[data-slot="navigation-highlight"]');
    const scroller = content.locator("..");
    const rows = sidebar.locator('[data-slot="project-group"] .session-item');
    const lastRow = rows.last();
    const metrics = () =>
      scroller.evaluate((element) => ({
        top: element.scrollTop,
        height: element.clientHeight,
        scrollHeight: element.scrollHeight,
      }));
    const fits = async () => {
      const { top, height, scrollHeight } = await metrics();
      return { top, excess: scrollHeight - height };
    };
    await expect(rows).toHaveCount(10, { timeout: 20_000 });

    for (const selectRow of [false, true]) {
      await expect
        .poll(async () => (await metrics()).scrollHeight > (await metrics()).height)
        .toBe(true);
      await lastRow.locator(".session-row").hover();
      const layer = sidebar.locator(
        `[data-slot="navigation-${selectRow ? "selection" : "hover"}"]`,
      );
      if (selectRow) await lastRow.locator(".session-row").click();
      await expect(layer).toHaveAttribute("data-visible", "true");
      await expect.poll(async () => (await metrics()).top).toBeGreaterThan(0);
      await expect
        .poll(async () => {
          const highlight = await layer.boundingBox();
          const row = await lastRow.boundingBox();
          return highlight && row ? Math.abs(highlight.y - row.y) : Infinity;
        })
        .toBeLessThan(1);

      // The header click removes the highlighted row; a transparent decoration
      // at its old offset must not keep an otherwise short sidebar scrollable.
      await sidebar.getByRole("button", { name: "Collapse project", exact: true }).click();
      await page.mouse.move(1090, 10);
      await expect(rows).toHaveCount(0);
      await expect(layer).toHaveAttribute("data-visible", "false");
      await expect.poll(fits).toEqual({ top: 0, excess: 0 });
      await scroller.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      await expect.poll(fits).toEqual({ top: 0, excess: 0 });

      // Keep the flexible viewport, including when it grows and shrinks again.
      for (const height of [900, 480]) {
        await page.setViewportSize({ width: 1100, height });
        await expect.poll(fits).toEqual({ top: 0, excess: 0 });
      }
      await sidebar.getByRole("button", { name: "Expand project", exact: true }).click();
      await expect(rows).toHaveCount(10);
      await lastRow.locator(".session-row").scrollIntoViewIfNeeded();
      await expect(lastRow).toBeInViewport();
      await scroller.evaluate((element) => {
        element.scrollTop = 0;
      });
      await expect(
        sidebar.getByRole("button", { name: "Collapse project", exact: true }),
      ).toBeInViewport();
    }

    // Exercise the screenshot's Resolved disclosure too, using real resolve
    // operations to move the same rows into the lane before collapsing it.
    for (let remaining = ids.length; remaining > 0; remaining--) {
      await lastRow.locator(".session-resolve-action").click();
      await expect(rows).toHaveCount(remaining - 1);
    }
    await sidebar.getByRole("button", { name: "Expand Resolved", exact: true }).click();
    await sidebar
      .getByRole("button", { name: "Expand project resolved", exact: true })
      .last()
      .click();
    await expect(rows).toHaveCount(10);
    await lastRow.locator(".session-row").hover();
    await expect(sidebar.locator('[data-slot="navigation-hover"]')).toHaveAttribute(
      "data-visible",
      "true",
    );
    await expect.poll(async () => (await metrics()).top).toBeGreaterThan(0);
    await sidebar.getByRole("button", { name: "Collapse Resolved", exact: true }).click();
    await expect(rows).toHaveCount(0);
    await expect.poll(fits).toEqual({ top: 0, excess: 0 });
    await scroller.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await expect.poll(fits).toEqual({ top: 0, excess: 0 });
    await sidebar.getByRole("button", { name: "Expand Resolved", exact: true }).click();
    await expect(rows).toHaveCount(10);
    await lastRow.locator(".session-row").scrollIntoViewIfNeeded();
    await expect(lastRow).toBeInViewport();
  } finally {
    await application.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
