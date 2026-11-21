import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "../../scripts/queued-electron.mjs";
import { expect, test, type Locator } from "@playwright/test";
import { findVisualCaptureScenario } from "../../scripts/visual-capture/scenarios";

const repository = resolve(import.meta.dirname, "../..");
const navigationTitle = "Improve project navigation across all ongoing projects and conversations";

async function titleAppearance(title: Locator) {
  return title.evaluate(async (element) => {
    // Let hover transitions actually start and finish before comparing geometry.
    await new Promise<void>((done) =>
      requestAnimationFrame(() => requestAnimationFrame(() => done())),
    );
    const row = element.closest("[data-todo-id]")!;
    await Promise.all(row.getAnimations({ subtree: true }).map((animation) => animation.finished));
    const style = getComputedStyle(element);
    const range = document.createRange();
    range.selectNodeContents(element);
    return {
      color: style.color,
      fontFamily: style.fontFamily,
      fontSize: style.fontSize,
      fontWeight: style.fontWeight,
      lineHeight: style.lineHeight,
      letterSpacing: style.letterSpacing,
      rects: Array.from(range.getClientRects(), ({ x, y, width, height }) => ({
        x,
        y,
        width,
        height,
      })),
    };
  });
}

for (const theme of ["light", "dark"] as const) {
  test(`to-do titles keep their hovered contrast and geometry at rest in ${theme} mode`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "cake-todo-title-style-"));
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
      const applicationPath = join(paths.cakeHome, "state", "application.json");
      const application = JSON.parse(await readFile(applicationPath, "utf8"));
      application.data.projects[0].todos.items.find(
        (item: { title: string }) => item.title === "Improve project navigation",
      ).title = navigationTitle;
      await writeFile(applicationPath, JSON.stringify(application));
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
      await page.emulateMedia({ reducedMotion: "no-preference", colorScheme: theme });
      await scenario.prepare(page, "done", app);
      const panel = page.getByRole("complementary", { name: "Workspace", exact: true });
      const associated = panel.getByRole("button", { name: "Startup investigation", exact: true });
      await expect(
        panel.getByRole("button", { name: "Focus to-do: Startup investigation", exact: true }),
      ).toHaveAttribute("aria-pressed", "true");
      await expect(associated.locator("..")).toHaveAttribute("data-associated", "true");
      // To-do focus is persistent view focus, not actual navigation selection.
      await expect(associated).not.toHaveAttribute("aria-current");
      await expect(associated.locator("..")).toHaveAttribute("data-view-focused", "true");
      await expect(associated.locator("..")).toHaveClass(/ring-accent/);

      for (const [name, done] of [
        ["Startup investigation", false],
        [navigationTitle, false],
        ["Discuss the next milestone", true],
      ] as const) {
        const action = panel.getByRole("button", { name, exact: true });
        const title = action.getByText(name, { exact: true });
        const row = action.locator("..");
        await page.mouse.move(1, 1);
        const resting = await titleAppearance(title);
        expect(resting.fontWeight).toBe("500");
        const background = await row.evaluate(
          (element) => getComputedStyle(element).backgroundColor,
        );
        await action.hover();
        const hovered = await titleAppearance(title);
        if (!done) {
          // The existing row hover foreground is the requested resting title contrast.
          const foreground = await row.evaluate((element) => getComputedStyle(element).color);
          expect.soft(resting.color).toBe(foreground);
        } else {
          // Done titles stay muted even when the description uses popover foreground.
          await expect(title).toHaveClass(/\btext-muted-foreground\b/);
          expect(resting.color).not.toBe(
            await row.evaluate((element) => getComputedStyle(element).color),
          );
        }
        expect.soft(hovered).toEqual(resting);
        expect(await row.evaluate((element) => getComputedStyle(element).backgroundColor)).not.toBe(
          background,
        );
        // Hovering leading controls must not move or recolor the title either.
        await row
          .getByRole("button", { name: `Change label for ${name}. Current label: Unlabelled` })
          .hover();
        expect(await titleAppearance(title)).toEqual(resting);
        await row
          .getByRole("button", { name: `Attach to-do as context: ${name}`, exact: true })
          .hover();
        expect(await titleAppearance(title)).toEqual(resting);
        await page.mouse.move(1, 1);
        expect(await titleAppearance(title)).toEqual(resting);
      }

      // Deselecting context retains the same typography and contrast.
      const title = associated.getByText("Startup investigation", { exact: true });
      await page.mouse.move(1, 1);
      const selected = await titleAppearance(title);
      const selectionBar = page.locator('[data-slot="selection-bar"]');
      await panel
        .getByRole("button", { name: "Unfocus to-do: Startup investigation", exact: true })
        .click();
      await expect(
        panel.getByRole("button", { name: "Focus to-do: Startup investigation", exact: true }),
      ).toHaveAttribute("aria-pressed", "false");
      await expect(associated.locator("..")).not.toHaveAttribute("data-associated");
      await page.mouse.move(1, 1);
      // Unfocus returns the row from the Focus overlay to its underlying section.
      // Position changes, but typography and rendered text dimensions stay identical.
      await expect(selectionBar).toHaveCount(0);
      const { rects: selectedRects, ...selectedTypography } = selected;
      const { rects: unfocusedRects, ...unfocusedTypography } = await titleAppearance(title);
      expect(unfocusedTypography).toEqual(selectedTypography);
      expect(unfocusedRects.map(({ width, height }) => ({ width, height }))).toEqual(
        selectedRects.map(({ width, height }) => ({ width, height })),
      );

      // The status indicator precedes the title; completion and attachment use fixed right-hand slots.
      for (const width of [1500, 600]) {
        await page.setViewportSize({ width, height: 900 });
        for (const [name, done] of [
          ["Startup investigation", false],
          [navigationTitle, false],
          ["Discuss the next milestone", true],
        ] as const) {
          const action = panel.getByRole("button", { name, exact: true });
          const row = action.locator("..");
          const completion = row.getByRole("button", {
            name: `${done ? "Reopen" : "Mark done"}: ${name}`,
            exact: true,
          });
          const attach = row.getByRole("button", {
            name: `Attach to-do as context: ${name}`,
            exact: true,
          });
          const status = row.locator('[data-slot="nav-trailing"] [role="img"]').first();
          await expect(attach).toBeVisible();
          await expect(attach.locator("svg")).toHaveAttribute("aria-hidden", "true");
          await expect(attach.locator("svg")).toHaveCSS("width", "12px");
          await expect(attach.locator("svg")).toHaveCSS("height", "12px");
          await expect(row.locator("button button")).toHaveCount(0);
          // Responsive pane transitions must settle before comparing independently read bounds.
          await expect(async () => {
            const completionBox = (await completion.boundingBox())!;
            const attachBox = (await attach.boundingBox())!;
            const titleBox = (await action.boundingBox())!;
            const statusBox = (await status.boundingBox())!;
            expect(statusBox.x + statusBox.width).toBeLessThan(titleBox.x);
            expect(completionBox.x + completionBox.width).toBeLessThanOrEqual(attachBox.x + 4);
            const rowBox = (await row.boundingBox())!;
            const actionsBox = (await row.locator('[data-slot="todo-actions"]').boundingBox())!;
            const layout = await row.evaluate((element) => {
              const style = getComputedStyle(element);
              return {
                tracks: style.gridTemplateColumns,
                rowWidth: element.clientWidth,
                scrollWidth: element.scrollWidth,
                viewport: innerWidth,
              };
            });
            expect(
              actionsBox.x + actionsBox.width,
              `${width}px: ${name} action group stays inside the row (${JSON.stringify(layout)})`,
            ).toBeLessThanOrEqual(rowBox.x + rowBox.width + 0.1);
            // Actions sit in their own reserved grid column (3977f22d), so the title ends
            // before them rather than running underneath a floating pill (769a863c).
            expect(titleBox.x + titleBox.width).toBeLessThanOrEqual(actionsBox.x);
            expect(attachBox.width).toBeGreaterThanOrEqual(24);
            expect(attachBox.height).toBeGreaterThanOrEqual(24);
            const alignment = await action.evaluate((element) => {
              const row = element.parentElement!;
              const style = getComputedStyle(element);
              const titleLeft = element.getBoundingClientRect().left;
              const titleCenter =
                element.getBoundingClientRect().top +
                parseFloat(style.paddingTop) +
                parseFloat(style.lineHeight) / 2;
              const icons = Array.from(
                row.querySelectorAll(
                  '[data-slot="nav-trailing"] [role="img"], [data-slot="todo-actions"] svg',
                ),
              );
              return {
                iconCenters: icons.map((icon) => {
                  const box = icon.getBoundingClientRect();
                  return box.top + box.height / 2;
                }),
                titleCenter,
                titleLeft,
                bodyLefts: Array.from(
                  row.querySelectorAll(":scope > p"),
                  (content) => content.getBoundingClientRect().left,
                ),
                lineHeight: parseFloat(style.lineHeight),
                actionCount: row.querySelectorAll('[data-slot="todo-actions"] button').length,
              };
            });
            // The leading status plus every row action, including Focus (3977f22d).
            expect(alignment.actionCount).toBeGreaterThanOrEqual(3);
            expect(alignment.iconCenters).toHaveLength(1 + alignment.actionCount);
            for (const center of alignment.iconCenters)
              expect(
                Math.abs(center - alignment.titleCenter),
                `${width}px ${name}: icon centers ${JSON.stringify(alignment.iconCenters)} vs title ${alignment.titleCenter}`,
              ).toBeLessThan(0.5);
            for (const left of alignment.bodyLefts)
              expect(Math.abs(left - alignment.titleLeft)).toBeLessThan(0.5);
            if (name === navigationTitle && width === 1500)
              expect(titleBox.height).toBeGreaterThan(alignment.lineHeight);
            expect(
              await row.evaluate((element) => element.scrollWidth <= element.clientWidth),
            ).toBe(true);
          }).toPass({ timeout: 3500 });
        }
      }
    } finally {
      await app?.close();
      await dispose?.();
      await rm(directory, { recursive: true, force: true });
    }
  });
}
