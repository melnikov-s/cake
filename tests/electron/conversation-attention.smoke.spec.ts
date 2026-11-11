import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { _electron as electron } from "../../scripts/queued-electron.mjs";
import { defaultApplicationState } from "../../src/contracts/application/application-data";
import { emptyProjectTodos } from "../../src/contracts/projects/project-todos";
import { seedCakeChatHistory } from "./durable-chat-fixture";
import { store, windowStateDocument } from "../fixtures/window-state";

const repository = resolve(import.meta.dirname, "../..");
for (const theme of ["dark", "light"] as const) {
  for (const count of [1, 2, 10]) {
    test(`inset attention: non-dismissive collapse, bounded list and existing actions (${theme}, ${count})`, async () => {
      const directory = await mkdtemp(join(tmpdir(), "cake-inset-attention-"));
      const cakeHome = join(directory, "cake");
      const userData = join(directory, "user-data");
      const file = join(cakeHome, "state", "application.json");
      const items = Array.from({ length: count }, (_, index) => ({
        id: `00000000-0000-4000-8000-${String(index + 11).padStart(12, "0")}`,
        title: `Review finding ${index + 1}`,
        attentionReason:
          index === count - 1
            ? "Review the detailed findings and choose the next step. ".repeat(4).trim()
            : "Choose the next step",
        description: "Findings ready",
        status: "",
        revision: 0,
        state: "open",
        needsAttention: true,
        attentionSequence: index + 1,
        associations: [],
      }));
      await mkdir(join(cakeHome, "state"), { recursive: true });
      await mkdir(userData, { recursive: true });
      await writeFile(
        file,
        JSON.stringify({
          version: 10,
          data: { ...defaultApplicationState(), cakeChatTodos: { ...emptyProjectTodos(), items } },
        }),
      );
      await writeFile(
        join(userData, "window-state.json"),
        windowStateDocument({ settingsStore: store({}, { appearance: store({ theme }) }) }),
      );
      await seedCakeChatHistory(cakeHome, "Keep the conversation primary while the sessions work.");
      const app = await electron.launch({
        args: [repository],
        cwd: repository,
        env: {
          ...process.env,
          CAKE_ELECTRON_SMOKE: "1",
          CAKE_HOME: cakeHome,
          CAKE_ELECTRON_USER_DATA: userData,
          PI_CODING_AGENT_DIR: join(cakeHome, "pi"),
          PI_CODING_AGENT_SESSION_DIR: "",
        },
      });
      try {
        const page = await app.firstWindow();
        const composer = page.getByRole("combobox", { name: "Message Cake Chat" });
        await expect(composer).toBeVisible();
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
        await composer.fill("Keep this unsent draft");
        const trigger = page.getByRole("button", { name: /^Needs attention ·/ });
        const panel = page
          .locator(".workbench-composer")
          .getByRole("region", { name: "Needs attention" });
        await expect(trigger).toHaveAttribute("aria-expanded", "false");
        await expect(panel).toHaveCount(0);
        const saved = async () => JSON.parse(await readFile(file, "utf8")).data.cakeChatTodos.items;
        await trigger.click();
        await expect(panel).toBeVisible();
        await expect(panel.getByRole("listitem")).toHaveCount(count);
        await panel
          .getByRole("button", { name: /^Open attention:/ })
          .first()
          .press("Escape");
        await expect(trigger).toBeFocused();
        await expect(panel).toHaveCount(0);
        expect(
          (await saved()).every((item: { needsAttention: boolean }) => item.needsAttention),
        ).toBe(true);
        await trigger.press("Enter");
        await composer.focus();
        await composer.press("Escape");
        await expect(composer).toBeFocused();
        await expect(panel).toBeVisible();
        for (const width of [1280, 640]) {
          await page.setViewportSize({ width, height: width === 640 ? 480 : 800 });
          const geometry = await panel.evaluate((element) => {
            const style = getComputedStyle(element);
            const input = document
              .querySelector('[data-slot="composer-input"]')!
              .getBoundingClientRect();
            return {
              height: element.getBoundingClientRect().height,
              bound: Math.min(168, innerHeight * 0.25),
              overflow: style.overflowY,
              fits: element.scrollWidth <= element.clientWidth,
              composerVisible: input.top >= 0 && input.bottom <= innerHeight,
            };
          });
          expect(geometry.height).toBeLessThanOrEqual(geometry.bound + 1);
          expect(geometry.overflow).toBe("auto");
          expect(geometry.fits).toBe(true);
          expect(geometry.composerVisible).toBe(true);
          if (count === 10) {
            await panel.hover();
            await page.mouse.wheel(0, 500);
            await expect
              .poll(() => panel.evaluate((element) => element.scrollTop))
              .toBeGreaterThan(0);
          }
          await mkdir(join(repository, ".visual-captures/inset-composer"), { recursive: true });
          await page.screenshot({
            path: join(
              repository,
              `.visual-captures/inset-composer/app-${theme}-${width}-${count}-attention.png`,
            ),
          });
        }
        await page.setViewportSize({ width: 1280, height: 800 });
        for (const item of items.slice(1).reverse()) {
          const clear = panel.getByRole("button", { name: `Clear attention: ${item.title}` });
          const open = panel.getByRole("button", { name: `Open attention: ${item.title}` });
          if (count === 2) {
            await composer.focus();
            await page.mouse.move(900, 450);
            await expect(clear).toHaveCSS("opacity", "0");
            await open.hover();
            await expect(clear).toHaveCSS("opacity", "1");
            await open.focus();
            await page.mouse.move(900, 450);
            await expect(clear).toHaveCSS("opacity", "1");
            await clear.focus();
            await clear.press("Shift+Tab");
            await expect(open).toBeFocused();
            await open.press("Tab");
            await expect(composer).toBeFocused();
            const cdp = await page.context().newCDPSession(page);
            await cdp.send("Emulation.setTouchEmulationEnabled", {
              enabled: true,
              maxTouchPoints: 1,
            });
            await expect(clear).toHaveCSS("opacity", "1");
            const bounds = (await clear.boundingBox())!;
            expect(bounds.height).toBeGreaterThanOrEqual(44);
            await cdp.send("Input.dispatchTouchEvent", {
              type: "touchStart",
              touchPoints: [{ x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }],
            });
            await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
            await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: false });
            await cdp.detach();
          } else {
            await clear.focus();
            const row = (await clear.boundingBox())!;
            const bounds = (await panel.boundingBox())!;
            expect(row.y).toBeGreaterThanOrEqual(bounds.y);
            expect(row.y + row.height).toBeLessThanOrEqual(bounds.y + bounds.height);
            await clear.press("Enter");
          }
          await expect(clear).toHaveCount(0);
        }
        await expect(trigger).toHaveAttribute("aria-label", "Needs attention · 1 to-dos");
        const open = panel.getByRole("button", { name: `Open attention: ${items[0]!.title}` });
        await open.focus();
        await open.press("Enter");
        await expect(trigger).toHaveCount(0);
        await expect(composer).toHaveValue("Keep this unsent draft");
        await composer.click();
        await composer.pressSequentially(" plus typing");
        await expect(composer).toHaveValue("Keep this unsent draft plus typing");
        expect(
          (await saved()).map((item: { needsAttention: boolean; state: string }) => [
            item.needsAttention,
            item.state,
          ]),
        ).toEqual(items.map(() => [false, "open"]));
        expect(
          await app.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows().every((window) => !window.isVisible()),
          ),
        ).toBe(true);
      } finally {
        await app.close();
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
}
