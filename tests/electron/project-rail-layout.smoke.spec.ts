import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { _electron as electron } from "../../scripts/queued-electron.mjs";
import { defaultApplicationState } from "../../src/contracts/application/application-data";
import { windowState } from "../fixtures/window-state";

test("centers the project rail's heading and rows until they need to scroll", async () => {
  test.setTimeout(90_000);
  const temporary = await mkdtemp(join(tmpdir(), "cake-project-rail-layout-"));
  const cakeHome = join(temporary, "cake-home");
  const userData = join(temporary, "user-data");
  const names = [
    "Cake",
    "Atlas",
    "Orchard",
    "Docs",
    "Canvas",
    "Garden",
    "Beacon",
    "Harbor",
    "Studio",
    "Field Notes",
  ];
  const timestamp = new Date(0).toISOString();
  const projects = names.map((name) => ({
    path: join(temporary, name),
    name,
    addedAt: timestamp,
    lastOpenedAt: timestamp,
  }));
  await Promise.all([
    mkdir(join(cakeHome, "state"), { recursive: true }),
    mkdir(userData),
    ...projects.map(({ path }) => mkdir(path)),
  ]);
  await writeFile(
    join(userData, "window-state.json"),
    windowState({
      project: projects[0]!.path,
      projects: projects.map(({ path }) => path),
      theme: "light",
    }),
  );
  await writeFile(
    join(cakeHome, "state", "application.json"),
    JSON.stringify({
      version: 11,
      data: {
        ...defaultApplicationState(),
        projects,
        leftToolbar: { autoHide: false, layout: "full" },
      },
    }),
  );
  const root = resolve(import.meta.dirname, "../..");
  const application = await electron.launch({
    args: [root],
    cwd: root,
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
    const window = await application.browserWindow(page);
    await page.emulateMedia({ reducedMotion: "reduce" });
    const resize = async (height: number) => {
      await window.evaluate((native, height) => native.setContentSize(960, height), height);
      await expect.poll(() => page.evaluate(() => innerHeight)).toBe(height);
    };
    const rail = page.getByRole("navigation", { name: "Projects and global utilities" });
    const scroll = rail.locator('[data-slot="project-rail-scroll"]');
    const list = rail.getByRole("region", { name: "Projects", exact: true });
    const heading = rail.getByRole("button", { name: "Add project", exact: true });
    const rows = list.getByRole("button", { name: /^Open Project Chat for / });
    const first = rows.first();
    const last = rows.last();
    const fixedActions = rail.getByRole("button", {
      name: /^(Open Cake Chat|New session|Search sessions|Artifacts|Automations|Settings|Browser sharing:.*)$/,
    });
    const actionBounds = () =>
      fixedActions.evaluateAll((buttons) =>
        buttons.map((button) => button.getBoundingClientRect().toJSON()),
      );
    const slack = async () => {
      const [viewport, start, end] = await Promise.all([
        scroll.boundingBox(),
        heading.boundingBox(),
        last.boundingBox(),
      ]);
      return {
        top: start!.y - viewport!.y,
        bottom: viewport!.y + viewport!.height - (end!.y + end!.height),
      };
    };
    const expectCentered = async () => {
      const { top, bottom } = await slack();
      expect(top).toBeGreaterThan(0);
      expect(Math.abs(top - bottom)).toBeLessThanOrEqual(1);
      return (await heading.boundingBox())!.y;
    };
    const capture = async (name: string) => {
      const path = join(root, ".visual-captures", `project-rail-${name}.png`);
      await mkdir(join(root, ".visual-captures"), { recursive: true });
      await rail.screenshot({ path, animations: "disabled" });
    };

    await resize(800);
    await expect(rail).toHaveAttribute("data-layout", "full");
    await expect(rows).toHaveCount(names.length, { timeout: 20_000 });
    expect(
      await rows.evaluateAll((buttons) =>
        buttons.map((button) => button.getAttribute("aria-label")),
      ),
    ).toEqual(names.map((name) => `Open Project Chat for ${name}`));
    const roomy = await expectCentered();
    await capture("fit");

    await resize(700);
    expect(await expectCentered()).toBeLessThan(roomy);

    await resize(560);
    const { top, bottom } = await slack();
    expect(Math.abs(top)).toBeLessThanOrEqual(1);
    expect(bottom).toBeLessThan(0);
    await expect(first).toBeInViewport({ ratio: 1 });
    await expect(last).not.toBeInViewport();
    await expect(fixedActions).toHaveCount(7);
    const fixed = await actionBounds();
    await capture("overflow-top");

    await list.focus();
    await page.keyboard.press("End");
    await expect(last).toBeInViewport({ ratio: 1 });
    await expect(heading).not.toBeInViewport();
    await expect
      .poll(() =>
        scroll.evaluate(
          (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
        ),
      )
      .toBeLessThanOrEqual(1);
    expect(await actionBounds()).toEqual(fixed);
    await capture("overflow-bottom");

    await page.keyboard.press("Home");
    await expect.poll(() => scroll.evaluate((element) => element.scrollTop)).toBe(0);
    await expect(heading).toBeInViewport({ ratio: 1 });
    await expect(first).toBeInViewport({ ratio: 1 });
    expect(await actionBounds()).toEqual(fixed);

    await resize(800);
    expect(await expectCentered()).toBe(roomy);
  } finally {
    await application.close();
    await rm(temporary, { recursive: true, force: true });
  }
});
