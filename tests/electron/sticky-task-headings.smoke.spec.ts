import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test, type Locator } from "@playwright/test";
import { _electron as electron } from "../../scripts/queued-electron.mjs";
import { findVisualCaptureScenario } from "../../scripts/visual-capture/scenarios";

const repository = resolve(import.meta.dirname, "../..");
const startup = "Investigate slow project startup";
const navigation =
  "Improve project navigation and preserve very-long-unbroken-workspace-identifiers-without-clipping-the-transcript";

async function scrollUntilMounted(transcript: Locator, target: Locator) {
  for (let step = 0; step < 100 && !(await target.count()); step++) {
    await transcript.evaluate((element) => {
      element.scrollTop += 350;
    });
    await transcript.page().waitForTimeout(40);
  }
  await expect(target).toHaveCount(1);
}

async function pin(transcript: Locator, target: Locator, beyond = 180) {
  await target.evaluate((element, beyond) => {
    const scroller = element.closest(".transcript")!;
    scroller.scrollTop +=
      element.getBoundingClientRect().top - scroller.getBoundingClientRect().top + beyond;
  }, beyond);
  await expect(async () => {
    const viewport = (await transcript.boundingBox())!;
    const label = (await target.boundingBox())!;
    expect(Math.abs(label.y - viewport.y)).toBeLessThanOrEqual(1);
  }).toPass();
}

for (const theme of ["dark", "light"] as const)
  test(`task headings stick, hand off and clear in the actual transcript scrollport (${theme})`, async ({}, testInfo) => {
    test.setTimeout(90_000);
    const root = await mkdtemp(join(tmpdir(), "cake-sticky-tasks-"));
    const paths = {
      cakeHome: join(root, "cake"),
      project: join(root, "project"),
      userData: join(root, "user-data"),
    };
    const scenario = findVisualCaptureScenario("project-chat-sticky-task-headings")!;
    await scenario.seed(paths, theme);
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
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]?.setContentSize(1440, 1000),
      );
      const page = await app.firstWindow();
      await scenario.prepare(page, "default");
      const transcript = page.locator(".transcript").last();
      const labels = transcript.locator('[data-slot="task-section-label"]');
      const first = transcript.locator(
        '[data-slot="task-section-header"][data-transcript-item-index="0"] [data-slot="task-section-label"]',
      );
      await transcript.evaluate((element) => {
        element.scrollTop = 1800;
      });
      await expect(async () => {
        expect((await first.boundingBox())!.y).toBe((await transcript.boundingBox())!.y);
      }).toPass();
      // The first message is already virtualized out; its single real label stays.
      await expect(transcript.getByText("Startup checkpoint 1.", { exact: true })).toHaveCount(0);
      await expect(
        first.getByRole("button", { name: `Focus to-do: ${startup}`, exact: true }),
      ).toBeVisible();
      await page.mouse.move(10, 10);
      await page.screenshot({ path: testInfo.outputPath(`mid-section-${theme}.png`) });

      const next = labels.filter({
        has: page.getByRole("button", { name: `Show in To-do: ${navigation}`, exact: true }),
      });
      await scrollUntilMounted(transcript, next);
      await pin(transcript, next);
      // One instance of each section heading, never a copied sticky overlay.
      await expect(next).toHaveCount(1);
      await expect(async () => {
        const old = (await first.boundingBox())!;
        expect(old.y + old.height).toBeLessThanOrEqual((await transcript.boundingBox())!.y);
      }).toPass();
      await page.screenshot({ path: testInfo.outputPath(`handoff-${theme}.png`) });

      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]?.setContentSize(900, 1000),
      );
      await pin(transcript, next, 0);
      await expect(async () => {
        const viewport = (await transcript.boundingBox())!;
        const label = (await next.boundingBox())!;
        expect(label.x).toBeGreaterThanOrEqual(viewport.x);
        expect(label.x + label.width).toBeLessThanOrEqual(viewport.x + viewport.width);
        expect(
          await transcript.evaluate((element) => element.scrollWidth <= element.clientWidth),
        ).toBe(true);
        const buttons = await next.getByRole("button").all();
        for (const button of buttons) {
          const box = (await button.boundingBox())!;
          expect(box.x + box.width).toBeLessThanOrEqual(label.x + label.width + 1);
        }
      }).toPass();
      await page.screenshot({ path: testInfo.outputPath(`narrow-${theme}.png`) });
      // Native buttons remain keyboard-operable while stuck, including folding.
      const disclosure = next.getByRole("button", { name: navigation, exact: true });
      await disclosure.focus();
      await disclosure.press("Space");
      await expect(disclosure).toHaveAttribute("aria-expanded", "false");
      await expect(disclosure).toBeFocused();
      await disclosure.press("Enter");
      await expect(disclosure).toHaveAttribute("aria-expanded", "true");
      await expect(disclosure).toBeFocused();
      const title = next.getByRole("button", { name: `Show in To-do: ${navigation}`, exact: true });
      await title.focus();
      await title.press("Enter");
      await expect(page.getByRole("complementary", { name: "Workspace" })).toBeVisible();
      const focus = next.getByRole("button", { name: `Focus to-do: ${navigation}`, exact: true });
      await focus.focus();
      await focus.press("Enter");
      await expect(
        page.getByRole("button", { name: "Clear to-do focus", exact: true }),
      ).toBeVisible();
      await page.getByRole("button", { name: "Clear to-do focus", exact: true }).click();
      const viewport = (await transcript.boundingBox())!;
      await page.mouse.move(viewport.x + viewport.width / 2, viewport.y + 100);
      await page.mouse.wheel(0, -100000);
      await expect.poll(() => transcript.evaluate((element) => element.scrollTop)).toBeLessThan(1);
      const general = transcript.getByText("General checkpoint 1.", { exact: true });
      await scrollUntilMounted(transcript, general);
      await general.evaluate((element) => {
        const scroller = element.closest(".transcript")!;
        scroller.scrollTop +=
          element.getBoundingClientRect().top - scroller.getBoundingClientRect().top + 150;
      });
      await expect(async () => {
        const top = (await transcript.boundingBox())!.y;
        for (const label of await labels.all()) {
          const box = (await label.boundingBox())!;
          expect(box.y + box.height <= top || box.y > top + 1).toBe(true);
        }
      }).toPass();
      await page.screenshot({ path: testInfo.outputPath(`unlabelled-${theme}.png`) });
      expect(
        await app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().every((window) => !window.isVisible()),
        ),
      ).toBe(true);
    } finally {
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  });
