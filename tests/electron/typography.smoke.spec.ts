import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { findVisualCaptureScenario } from "../../scripts/visual-capture/scenarios";

const repositoryRoot = resolve(import.meta.dirname, "../..");

for (const theme of ["light", "dark"] as const) {
  for (const [name, state] of [
    ["nested-tool-activity", "script"],
    ["mcp-settings-layout", "default"],
    ["project-custom-instructions", "browser"],
    ["assistant-markdown-code", "default"],
  ] as const) {
    test(`small UI text is readable and scales in ${name} (${theme})`, async () => {
      test.setTimeout(60_000);
      const root = await mkdtemp(join(tmpdir(), "cake-typography-"));
      const paths = {
        cakeHome: join(root, "cake-home"),
        project: join(root, "project"),
        userData: join(root, "user-data"),
      };
      const scenario = findVisualCaptureScenario(name)!;
      await scenario.seed(paths, theme);
      const application = await electron.launch({
        args: ["--force-device-scale-factor=1", repositoryRoot],
        cwd: repositoryRoot,
        env: {
          ...process.env,
          CAKE_ELECTRON_SMOKE: "1",
          CAKE_ELECTRON_USER_DATA: paths.userData,
          CAKE_HOME: paths.cakeHome,
          PI_CODING_AGENT_DIR: join(paths.cakeHome, "pi"),
          PI_CODING_AGENT_SESSION_DIR: "",
        },
      });
      try {
        const page = await application.firstWindow();
        await scenario.prepare(page, state, application);
        for (const width of [1280, 800]) {
          await application.evaluate(({ BrowserWindow }, width) => {
            BrowserWindow.getAllWindows()[0]!.setContentSize(width, 1000);
          }, width);
          await page.waitForFunction((width) => innerWidth === width, width);
          for (const scale of [100, 125]) {
            await page.evaluate((scale) => {
              document.documentElement.style.fontSize = `${scale}%`;
            }, scale);
            await expect
              .poll(() =>
                page.evaluate(() => {
                  const floor =
                    Number.parseFloat(getComputedStyle(document.documentElement).fontSize) * 0.875;
                  const undersized: string[] = [];
                  let count = 0;
                  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
                  while (walker.nextNode()) {
                    const text = walker.currentNode;
                    const parent = text.parentElement;
                    if (!parent || !text.textContent?.trim() || !(parent instanceof HTMLElement))
                      continue;
                    const style = getComputedStyle(parent);
                    if (style.visibility !== "visible") continue;
                    const range = document.createRange();
                    range.selectNode(text);
                    const rect = range.getBoundingClientRect();
                    if (
                      !rect.width ||
                      !rect.height ||
                      rect.bottom <= 0 ||
                      rect.top >= innerHeight ||
                      rect.right <= 0 ||
                      rect.left >= innerWidth
                    )
                      continue;
                    count++;
                    if (Number.parseFloat(style.fontSize) < floor - 0.1) {
                      undersized.push(
                        `${parent.tagName}: ${text.textContent.trim().slice(0, 60)} (${style.fontSize})`,
                      );
                    }
                    const before = getComputedStyle(parent, "::before");
                    if (
                      before.content !== "none" &&
                      before.content !== "normal" &&
                      Number.parseFloat(before.fontSize) < floor - 0.1
                    ) {
                      undersized.push(`line number: ${before.fontSize}`);
                    }
                  }
                  return { count, undersized };
                }),
              )
              .toMatchObject({ undersized: [] });
            const metrics = await scenario.region(page, state).evaluate((region) => ({
              fits: region.scrollWidth <= region.clientWidth + 1,
              textCount: region.textContent?.trim().length ?? 0,
              clippedControls: [...region.querySelectorAll("button")]
                .filter((button) => {
                  if (!button.innerText.trim() || !button.getClientRects().length) return false;
                  // Exclude intentional horizontally truncated labels; catch vertical clipping.
                  return button.scrollHeight > button.clientHeight + 1;
                })
                .map((button) => button.innerText),
            }));
            expect(metrics.textCount).toBeGreaterThan(0);
            expect(metrics.fits, JSON.stringify({ width, scale, ...metrics })).toBe(true);
            expect(metrics.clippedControls).toEqual([]);
          }
        }
        expect(
          await application.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows().every(
              (window) => !window.isVisible() && !window.isFocused(),
            ),
          ),
        ).toBe(true);
      } finally {
        await application.close();
        await rm(root, { recursive: true, force: true });
      }
    });
  }
}
