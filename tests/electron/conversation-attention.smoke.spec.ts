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

const scenarios = (["dark", "light"] as const).flatMap((theme) =>
  [2, 3, 10].map((count) => ({ theme, count })),
);
for (const { theme, count } of scenarios) {
  test(`own-chat attention pills: bounded list, X, activation and preserved draft (${theme}, ${count} items)`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "cake-attention-pills-"));
    const paths = {
      cakeHome: join(directory, "cake"),
      project: join(directory, "project"),
      userData: join(directory, "user-data"),
    };
    const file = join(paths.cakeHome, "state", "application.json");
    const items = [
      {
        id: "00000000-0000-4000-8000-000000000011",
        title: "Startup investigation",
        attentionReason: "Review the startup findings before deciding the next step",
      },
      {
        id: "00000000-0000-4000-8000-000000000012",
        title: "Choose navigation",
        attentionReason: "Which navigation approach should we use?",
      },
      ...Array.from({ length: count - 2 }, (_, index) => ({
        id: `00000000-0000-4000-8000-${String(index + 13).padStart(12, "0")}`,
        title: `Additional finding ${index + 1}`,
        attentionReason:
          index === count - 3
            ? "Review these detailed findings and choose the next step. ".repeat(4).trim()
            : `Review additional finding ${index + 1}`,
      })),
    ].map((item) => ({
      ...item,
      description: "Findings ready",
      status: "",
      revision: 0,
      state: "open",
      needsAttention: true,
      associations: [],
    }));
    await mkdir(join(paths.cakeHome, "state"), { recursive: true });
    await mkdir(paths.userData, { recursive: true });
    await writeFile(
      file,
      JSON.stringify({
        version: 10,
        data: { ...defaultApplicationState(), cakeChatTodos: { ...emptyProjectTodos(), items } },
      }),
    );
    await writeFile(
      join(paths.userData, "window-state.json"),
      windowStateDocument({ settingsStore: store({}, { appearance: store({ theme }) }) }),
    );
    await seedCakeChatHistory(
      paths.cakeHome,
      "Let’s keep the launch decisions here while the sessions work.",
    );
    const app = await electron.launch({
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
    try {
      const page = await app.firstWindow();
      await page.setViewportSize({ width: 1280, height: 800 });
      const composer = page.getByRole("combobox", { name: "Message Cake Chat" });
      if (!(await composer.isVisible()))
        await page
          .getByRole("button", { name: /^(Open )?Cake Chat$/ })
          .first()
          .click();
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await expect(composer).toBeVisible();
      await composer.fill("Keep this unsent draft");
      const queue = page
        .locator(".workbench-composer")
        .getByRole("region", { name: "Needs attention" });
      await expect(queue).toBeVisible();
      await expect(queue.getByRole("button")).toHaveCount(count * 2);
      await expect(queue.getByRole("heading")).toHaveText(`Needs attention${count}`);
      const list = queue.getByRole("list", { name: "Needs attention items" });
      const metrics = () =>
        list.evaluate((element) => {
          const rows = Array.from(element.children);
          const style = getComputedStyle(element);
          const threeRowHeight =
            rows[Math.min(2, rows.length - 1)].getBoundingClientRect().bottom -
            rows[0].getBoundingClientRect().top +
            parseFloat(style.paddingTop) +
            parseFloat(style.paddingBottom);
          return {
            height: element.clientHeight,
            total: element.scrollHeight,
            limit: Math.min(threeRowHeight, innerHeight * 0.3),
            overflow: style.overflowY,
            containment: style.overscrollBehaviorY,
            scrollTop: element.scrollTop,
          };
        });
      await expect
        .poll(async () => {
          const { height, limit } = await metrics();
          return Math.abs(height - limit);
        })
        .toBeLessThanOrEqual(1);
      expect((await metrics()).overflow).toBe("auto");
      if (count <= 3) {
        const { height, total } = await metrics();
        expect(total).toBeLessThanOrEqual(height + 1);
      } else {
        expect((await metrics()).total).toBeGreaterThan((await metrics()).height);
        expect((await metrics()).containment).toBe("contain");
        await page.setViewportSize({ width: 640, height: 480 });
        await expect
          .poll(async () => {
            const { height, limit } = await metrics();
            return Math.abs(height - limit);
          })
          .toBeLessThanOrEqual(1);
        const inputBefore = await composer.boundingBox();
        await list.hover();
        await page.mouse.wheel(0, 500);
        await expect.poll(async () => (await metrics()).scrollTop).toBeGreaterThan(0);
        expect((await composer.boundingBox())!.y).toBeCloseTo(inputBefore!.y, 0);
        const lastClear = queue.getByRole("button", {
          name: `Clear attention: ${items[0].title}`,
        });
        await lastClear.focus();
        await expect(lastClear).toBeFocused();
        const listBounds = (await list.boundingBox())!;
        const actionBounds = (await lastClear.boundingBox())!;
        expect(actionBounds.y).toBeGreaterThanOrEqual(listBounds.y + 3);
        expect(actionBounds.y + actionBounds.height).toBeLessThanOrEqual(
          listBounds.y + listBounds.height - 3,
        );
        await lastClear.press("Shift+Tab");
        const lastOpen = queue.getByRole("button", {
          name: `Open attention: ${items[0].title}`,
        });
        await expect(lastOpen).toBeFocused();
        await lastOpen.press("Tab");
        await expect(composer).toBeFocused();
        await mkdir(join(repository, ".visual-captures"), { recursive: true });
        await page.screenshot({
          path: join(repository, ".visual-captures", `attention-bounded-${theme}.png`),
        });
        await page.setViewportSize({ width: 1280, height: 800 });
      }
      for (const extra of items.slice(2).reverse()) {
        const clearExtra = queue.getByRole("button", { name: `Clear attention: ${extra.title}` });
        await clearExtra.focus();
        await clearExtra.press("Enter");
        await expect(clearExtra).toHaveCount(0);
        if ((await list.getByRole("listitem").count()) <= 3) {
          await expect
            .poll(async () => {
              const { total, height } = await metrics();
              return total - height;
            })
            .toBeLessThanOrEqual(1);
        }
      }
      await expect(queue.getByRole("button")).toHaveCount(4);
      await expect(queue.getByText("Review", { exact: true })).toHaveCount(0);
      await expect(queue.getByText("This chat’s to-dos")).toHaveCount(0);
      const bounds = await queue.boundingBox();
      const inputBounds = await composer.boundingBox();
      expect(bounds!.y + bounds!.height).toBeLessThan(inputBounds!.y);
      for (const button of await queue.getByRole("button").all()) {
        const size = await button.boundingBox();
        expect(size!.height).toBeGreaterThanOrEqual(28);
      }
      await composer.click();
      await page.mouse.move(900, 450);
      await expect(page.locator('[data-slot="project-rail"]')).toHaveCSS("width", "54px");
      const clear = queue.getByRole("button", { name: `Clear attention: ${items[1].title}` });
      const pill = queue.getByRole("button", { name: `Open attention: ${items[1].title}` });
      await expect(clear.locator("svg")).toHaveCSS("width", "12px");
      await expect(clear).toHaveCSS("opacity", "0");
      await pill.hover();
      await expect(clear).toHaveCSS("opacity", "1");
      await composer.click();
      await page.mouse.move(900, 450);
      await expect(clear).toHaveCSS("opacity", "0");
      await pill.focus();
      await expect(clear).toHaveCSS("opacity", "1");
      await clear.focus();
      await expect(clear).toBeFocused();
      await expect(clear).toHaveCSS("opacity", "1");
      await clear.press("Shift+Tab");
      await expect(pill).toBeFocused();
      // Cake reserves plain Tab for returning to the composer.
      await pill.press("Tab");
      await expect(composer).toBeFocused();
      await composer.click();
      await page.mouse.move(900, 450);
      await expect(clear).toHaveCSS("opacity", "0");
      await mkdir(join(repository, ".visual-captures"), { recursive: true });
      await page.screenshot({
        path: join(repository, ".visual-captures", `attention-pills-${theme}.png`),
      });
      await pill.hover();
      await expect(clear).toHaveCSS("opacity", "1");
      await page.screenshot({
        path: join(repository, ".visual-captures", `attention-pills-hover-${theme}.png`),
      });
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
      expect(await page.evaluate(() => matchMedia("(any-pointer: coarse)").matches)).toBe(true);
      await composer.focus();
      await page.mouse.move(900, 450);
      await expect(clear).toHaveCSS("opacity", "1");
      const touchTarget = await clear.boundingBox();
      expect(touchTarget!.height).toBeGreaterThanOrEqual(44);
      await page.screenshot({
        path: join(repository, ".visual-captures", `attention-pills-touch-${theme}.png`),
      });
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [
          {
            x: touchTarget!.x + touchTarget!.width / 2,
            y: touchTarget!.y + touchTarget!.height / 2,
          },
        ],
      });
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: false });
      await cdp.detach();
      await expect(queue.getByRole("button")).toHaveCount(2);
      const single = await metrics();
      expect(single.total).toBeLessThanOrEqual(single.height + 1);
      await expect(composer).toHaveValue("Keep this unsent draft");
      const open = queue.getByRole("button", { name: `Open attention: ${items[0].title}` });
      await open.focus();
      await open.press("Enter");
      await expect(queue).toHaveCount(0);
      await expect(composer).toHaveValue("Keep this unsent draft");
      await composer.click();
      await composer.pressSequentially(" plus typing");
      await expect(composer).toHaveValue("Keep this unsent draft plus typing");
      await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
      const saved = JSON.parse(await readFile(file, "utf8")).data.cakeChatTodos.items;
      expect(
        saved
          .slice(0, 2)
          .map((item: { needsAttention: boolean; state: string }) => [
            item.needsAttention,
            item.state,
          ]),
      ).toEqual([
        [false, "open"],
        [false, "open"],
      ]);
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
