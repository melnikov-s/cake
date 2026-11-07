import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { _electron as electron } from "../../scripts/queued-electron.mjs";
import { findVisualCaptureScenario } from "../../scripts/visual-capture/scenarios";

async function expectTitlebarAlignment(application: ElectronApplication, page: Page) {
  if (process.platform !== "darwin") return;
  const window = await application.browserWindow(page);
  let lights = await window.evaluate((native) => native.getWindowButtonPosition());
  expect(lights).not.toBeNull();
  let center = lights!.y + 7;
  const breadcrumb = page.getByRole("navigation", { name: "Conversation breadcrumb" });
  const first = breadcrumb.getByRole("button").first();
  const workspace = page.getByRole("complementary", { name: "Workspace", exact: true });
  const targets = [
    first,
    workspace.getByRole("button", { name: /^To-dos / }),
    workspace.getByRole("button", { name: /^Sessions / }),
    page.getByRole("button", { name: "Close Workspace", exact: true }),
  ];
  await expect
    .poll(async () => {
      lights = await window.evaluate((native) => native.getWindowButtonPosition());
      if (!lights) return false;
      center = lights.y + 7;
      const boxes = await Promise.all(targets.map((target) => target.boundingBox()));
      return boxes.every((box) => box && Math.abs(box.y + box.height / 2 - center) < 0.75);
    })
    .toBe(true);
  test
    .info()
    .annotations.push({ type: "native-titlebar", description: JSON.stringify({ lights, center }) });
  const firstBounds = (await first.boundingBox())!;
  const zoomRight = lights!.x + 2 * 23 + 14;
  expect(firstBounds.x).toBeGreaterThanOrEqual(zoomRight);
  const railBounds = (await page.locator('[data-slot="project-rail"]').boundingBox())!;
  expect(railBounds.y).toBeGreaterThan(center + 7);
  await expect(first).toHaveCSS("-webkit-app-region", "no-drag");
  await expect(page.locator('[data-slot="window-controls-drag-region"]')).toHaveCSS(
    "-webkit-app-region",
    "drag",
  );
  await test.info().attach("native-titlebar-alignment", {
    body: JSON.stringify({ lights, center, firstBounds, railBounds }),
    contentType: "application/json",
  });
}

test("narrow navigation overlays labels, keeps overflowing projects reachable and returns from dedicated application views", async () => {
  test.setTimeout(180_000);
  const temporary = await mkdtemp(join(tmpdir(), "cake-navigation-polish-"));
  const paths = {
    cakeHome: join(temporary, "cake-home"),
    project: join(temporary, "project"),
    userData: join(temporary, "user-data"),
  };
  const scenario = findVisualCaptureScenario("chat-first-navigation")!;
  const cleanup = await scenario.seed(paths, "dark");
  const repositoryRoot = resolve(import.meta.dirname, "../..");
  const application = await electron.launch({
    args: [repositoryRoot],
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
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setContentSize(960, 784),
    );
    await scenario.prepare(page, "project-todos", application);
    const rail = page.getByRole("navigation", { name: "Projects and global utilities" });
    const input = page.getByRole("combobox", { name: "Message Project Chat", exact: true });
    await input.click();
    await expect(input).toBeFocused();
    await input.pressSequentially("Preserve this conversation draft");
    await page.mouse.move(500, 220);
    await expect.poll(async () => (await rail.boundingBox())!.width).toBe(54);
    await expectTitlebarAlignment(application, page);
    const workspaceControlBounds = async () => {
      const tools = page.getByRole("group", { name: "Workspace tools", exact: true });
      const titleBarHeight = await tools.evaluate((element) =>
        Number.parseFloat(getComputedStyle(element.closest("header")!).height),
      );
      return Promise.all(
        [
          tools,
          tools.getByRole("button", { name: /^(Main|Back to agent)$/ }),
          tools.getByRole("button", { name: "Open VS Code", exact: true }),
          tools.getByRole("button", { name: "Open Browser Mode", exact: true }),
          tools.getByRole("button", { name: "Terminal", exact: true }),
        ].map(async (control) => {
          const box = await control.boundingBox();
          return box && { ...box, y: box.y - titleBarHeight / 2 };
        }),
      );
    };
    const chatControlBounds = await workspaceControlBounds();
    expect(chatControlBounds.every(Boolean)).toBe(true);
    const workspace = page.locator('[data-slot="workspace"]');
    const before = (await workspace.boundingBox())!;
    const projects = rail.getByRole("region", { name: "Projects", exact: true });
    expect(await projects.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(
      true,
    );
    const footerBefore = (await rail
      .getByRole("button", { name: "Settings", exact: true })
      .boundingBox())!;
    await rail.hover();
    await expect.poll(async () => (await rail.boundingBox())!.width).toBe(240);
    for (const name of [
      "Add project",
      "Search sessions",
      "Settings",
      "Automations",
      "Artifacts",
      "Browser sharing: Offline — go online",
    ]) {
      const action = name.startsWith("Browser")
        ? rail.getByRole("button", { name: /^Browser sharing:/ })
        : rail.getByRole("button", { name, exact: true });
      await expect(action.locator('[data-slot="icon-button-label"]')).toBeVisible();
    }
    expect((await workspace.boundingBox())!.x).toBe(before.x);
    expect((await workspace.boundingBox())!.width).toBe(before.width);
    const last = rail.getByRole("button", {
      name: "Open Project Chat for project-28",
      exact: true,
    });
    await last.focus();
    await page.mouse.move(500, 220);
    await expect.poll(async () => (await rail.boundingBox())!.width).toBe(240);
    await expect(last).toBeFocused();
    expect(await projects.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    expect(
      (await rail.getByRole("button", { name: "Settings", exact: true }).boundingBox())!.y,
    ).toBe(footerBefore.y);
    await page.keyboard.press("Shift+Tab");
    await expect(rail.locator(":focus")).toHaveCount(1);
    await expect.poll(async () => (await rail.boundingBox())!.width).toBe(240);
    for (const name of ["Settings", "Automations"]) {
      await rail.getByRole("button", { name, exact: true }).click();
      await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
      await expect(rail).toHaveCount(0);
      expect((await workspace.boundingBox())!.x).toBe(0);
      await expect(page.locator('[data-slot="shell-workspace-toggle"]')).toHaveCount(0);
      expect(
        await (await application.browserWindow(page)).evaluate((native) => native.isFullScreen()),
      ).toBe(false);
      await page.getByRole("button", { name: "Back to chat", exact: true }).click();
      await expect(input).toHaveValue("Preserve this conversation draft");
      await expect(workspace).toHaveAttribute("data-session-id", /^project-chat:/);
    }
    const accessory = page.getByRole("complementary", { name: "Workspace", exact: true });
    await accessory.getByRole("button", { name: /^Sessions / }).click();
    await accessory.getByRole("button", { name: "New Session", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "New session", exact: true })).toBeVisible();
    await page
      .getByRole("dialog", { name: "New session", exact: true })
      .getByRole("button", { name: "Close", exact: true })
      .click();
    await scenario.prepare(page, "browser", application);
    await expectTitlebarAlignment(application, page);
    expect(await workspaceControlBounds()).toEqual(chatControlBounds);
    const splitter = (await page
      .getByRole("separator", { name: "Resize current session sidebar", exact: true })
      .boundingBox())!;
    const toolControl = (await page
      .getByRole("button", { name: "Open VS Code", exact: true })
      .boundingBox())!;
    expect(splitter.y).toBeGreaterThanOrEqual(toolControl.y + toolControl.height);
    await page.getByRole("combobox", { name: "Message", exact: true }).click();
    await page.mouse.move(500, 220);
    await expect.poll(async () => (await rail.boundingBox())!.width).toBe(54);
    // The DOM canvas does not move; its actual native child view clears the rail overlay.
    const canvasBefore = await page.locator('[aria-label="Browser viewport"]').boundingBox();
    await rail.hover();
    await expect.poll(async () => (await rail.boundingBox())!.width).toBe(240);
    await expect
      .poll(async () =>
        application.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0]!.contentView.children.some((view) => {
            const bounds = view.getBounds();
            return bounds.x >= 240 && bounds.width > 0;
          }),
        ),
      )
      .toBe(true);
    expect(await page.locator('[aria-label="Browser viewport"]').boundingBox()).toEqual(
      canvasBefore,
    );
    await expect(
      rail
        .getByRole("button", { name: "Settings", exact: true })
        .locator('[data-slot="icon-button-label"]'),
    ).toBeVisible();
    const workerInput = page.getByRole("combobox", { name: "Message", exact: true });
    await workerInput.click();
    await workerInput.pressSequentially("Keep the Browser conversation draft");
    await rail.getByRole("button", { name: "Automations", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Automations", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Back to chat", exact: true }).click();
    await expect(workerInput).toHaveValue("Keep the Browser conversation draft");
    await expect(
      page.getByRole("button", { name: "Open Browser Mode", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
    const touchMedia = await page.evaluate(() => matchMedia("(hover: none)").matches);
    test.info().annotations.push({ type: "touch-css-media", description: String(touchMedia) });
    await test.info().attach("touch-media", {
      body: JSON.stringify({ touchMedia }),
      contentType: "application/json",
    });
    if (touchMedia) {
      await workerInput.focus();
      await expect.poll(async () => (await rail.boundingBox())!.width).toBe(54);
      const reveal = rail.getByRole("button", { name: "Show navigation labels", exact: true });
      await expect(reveal).toBeVisible();
      const target = (await reveal.boundingBox())!;
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ x: target.x + target.width / 2, y: target.y + target.height / 2 }],
      });
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await expect(reveal).toBeFocused();
      await expect.poll(async () => (await rail.boundingBox())!.width).toBe(240);
      await expect(
        rail
          .getByRole("button", { name: "Settings", exact: true })
          .locator('[data-slot="icon-button-label"]'),
      ).toBeVisible();
    } else {
      test.info().annotations.push({
        type: "coverage-limit",
        description:
          "Desktop Electron did not expose coarse-pointer CSS media under touch emulation; physical touch not verified.",
      });
    }
    await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: false });
    await cdp.detach();
    await scenario.prepare(page, "vscode", application);
    await expectTitlebarAlignment(application, page);
    expect(await workspaceControlBounds()).toEqual(chatControlBounds);
    const windows = await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().map((native) => ({
        visible: native.isVisible(),
        focused: native.isFocused(),
      })),
    );
    expect(windows.every((native) => !native.visible && !native.focused)).toBe(true);
  } finally {
    await application.close();
    if (typeof cleanup === "function") await cleanup();
    await rm(temporary, { recursive: true, force: true });
  }
});
