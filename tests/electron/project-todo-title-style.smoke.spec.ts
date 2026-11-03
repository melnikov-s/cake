import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test, type Locator } from "@playwright/test";
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
      const panel = page.getByRole("complementary", { name: "To-do", exact: true });
      const associated = panel.getByRole("button", { name: "Startup investigation", exact: true });
      await expect(associated).toHaveAttribute("aria-pressed", "true");
      await expect(associated.locator("..")).toHaveAttribute("data-associated", "true");
      // Association is an advisory cue, not actual navigation selection.
      await expect(associated).not.toHaveAttribute("aria-current");
      await expect(associated.locator("..")).toHaveClass(/outline-dashed/);

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
          const status = row.getByText("Agree on the next milestone’s scope and priorities.");
          expect(resting.color).toBe(
            await status.evaluate((element) => getComputedStyle(element).color),
          );
        }
        expect.soft(hovered).toEqual(resting);
        expect(await row.evaluate((element) => getComputedStyle(element).backgroundColor)).not.toBe(
          background,
        );
        // Hovering leading controls must not move or recolor the title either.
        await row
          .getByRole("button", { name: `${done ? "Reopen" : "Mark done"}: ${name}`, exact: true })
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
      await expect(associated).toHaveAttribute("aria-pressed", "false");
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

      // Completion and attachment stay separate, before the wrapping title at both pane widths.
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
          await expect(attach).toBeVisible();
          await expect(attach.locator("svg")).toHaveAttribute("aria-hidden", "true");
          await expect(attach.locator("svg")).toHaveAttribute("width", "14");
          await expect(attach.locator("svg")).toHaveAttribute("height", "14");
          await expect(row.locator("button button")).toHaveCount(0);
          // Responsive pane transitions must settle before comparing independently read bounds.
          await expect(async () => {
            const completionBox = (await completion.boundingBox())!;
            const attachBox = (await attach.boundingBox())!;
            const titleBox = (await action.boundingBox())!;
            expect(completionBox.x + completionBox.width).toBeLessThan(attachBox.x);
            expect(attachBox.x + attachBox.width).toBeLessThan(titleBox.x);
            const alignment = await action.evaluate((element) => {
              const row = element.parentElement!;
              const style = getComputedStyle(element);
              const titleCenter =
                element.getBoundingClientRect().top +
                parseFloat(style.paddingTop) +
                parseFloat(style.lineHeight) / 2;
              const icons = Array.from(row.querySelectorAll('[data-slot="nav-trailing"] svg'));
              const rowStyle = getComputedStyle(row);
              const contentLeft =
                row.getBoundingClientRect().left + parseFloat(rowStyle.paddingLeft);
              return {
                iconCenters: icons.map((icon) => {
                  const box = icon.getBoundingClientRect();
                  return box.top + box.height / 2;
                }),
                titleCenter,
                contentLeft,
                bodyLefts: Array.from(
                  row.querySelectorAll(":scope > p, :scope > ul"),
                  (content) => content.getBoundingClientRect().left,
                ),
                lineHeight: parseFloat(style.lineHeight),
              };
            });
            expect(alignment.iconCenters).toHaveLength(2);
            for (const center of alignment.iconCenters)
              expect(Math.abs(center - alignment.titleCenter)).toBeLessThan(0.02);
            expect(alignment.bodyLefts.length).toBeGreaterThan(0);
            for (const left of alignment.bodyLefts)
              expect(Math.abs(left - alignment.contentLeft)).toBeLessThan(0.02);
            if (name === navigationTitle && width === 1500)
              expect(titleBox.height).toBeGreaterThan(alignment.lineHeight);
            expect(
              await row.evaluate((element) => element.scrollWidth <= element.clientWidth),
            ).toBe(true);
          }).toPass();
        }
      }
    } finally {
      await app?.close();
      await dispose?.();
      await rm(directory, { recursive: true, force: true });
    }
  });
}
