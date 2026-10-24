import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test, type Locator } from "@playwright/test";
import { findVisualCaptureScenario } from "../../scripts/visual-capture/scenarios";

const repository = resolve(import.meta.dirname, "../..");

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
        ["Improve project navigation", false],
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
          const status = row.getByText("Decision recorded");
          expect(resting.color).toBe(
            await status.evaluate((element) => getComputedStyle(element).color),
          );
        }
        expect.soft(hovered).toEqual(resting);
        expect(await row.evaluate((element) => getComputedStyle(element).backgroundColor)).not.toBe(
          background,
        );
        // Hovering trailing controls must not move or recolor the title either.
        await row
          .getByRole("button", { name: `${done ? "Reopen" : "Mark done"}: ${name}`, exact: true })
          .hover();
        expect(await titleAppearance(title)).toEqual(resting);
        await page.mouse.move(1, 1);
        expect(await titleAppearance(title)).toEqual(resting);
      }

      // Deselecting context retains the same typography and contrast.
      const title = associated.getByText("Startup investigation", { exact: true });
      await page.mouse.move(1, 1);
      const selected = await titleAppearance(title);
      await associated.click();
      await expect(associated).toHaveAttribute("aria-pressed", "false");
      await expect(associated.locator("..")).not.toHaveAttribute("data-associated");
      await page.mouse.move(1, 1);
      expect(await titleAppearance(title)).toEqual(selected);
    } finally {
      await app?.close();
      await dispose?.();
      await rm(directory, { recursive: true, force: true });
    }
  });
}
