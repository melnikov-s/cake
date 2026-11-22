import { test, expect } from "@playwright/test";
import { mkdtemp, writeFile, access, readFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveConfig } from "electron-vite";
import { build, createServer } from "vite";
import { _electron } from "../../scripts/queued-electron.mjs";

// Unlike ordinary smoke tests, inspection needs a development renderer and a real
// unpacked extension. Everything runs hidden with synthetic, isolated profiles.
test("native RStateTree panel discovers Cake roots and rereads live navigation", async () => {
  test.setTimeout(900_000);
  const directory = await mkdtemp(join(tmpdir(), "cake-rst-devtools-"));
  // Keep dependencies resolvable without replacing the production build under test.
  const outDir = await mkdtemp(join(resolve("out"), "rst-devtools-"));
  const holdDirectory = process.env.CAKE_RST_INSPECTION_HOLD_DIR;
  const productionBuild = async () => ({
    main: createHash("sha256")
      .update(await readFile(resolve("out/main/main.js")))
      .digest("hex"),
    hasDictationHelper: await access(resolve("out/main/native/cake-dictation")).then(
      () => true,
      () => false,
    ),
  });
  const beforeBuild = await productionBuild();
  process.env.CAKE_BUILD_MODE = "slim";
  process.env.NODE_ENV = "development";
  process.env.NODE_ENV_ELECTRON_VITE = "development";
  const resolved = await resolveConfig({ build: { outDir } }, "serve", "development");
  const config = resolved.config;
  if (!config?.main || !config.preload || !config.renderer)
    throw new Error("Missing desktop development configuration");
  await build(config.main);
  await build(config.preload);
  expect(await productionBuild()).toEqual(beforeBuild);
  let server = await createServer(config.renderer);
  await server.listen();
  const origin = server.resolvedUrls?.local[0];
  if (!origin) throw new Error("Missing loopback development origin");
  const application = await _electron.launch({
    args: [join(outDir, "main", "main.js")],
    env: {
      ...process.env,
      ELECTRON_RENDERER_URL: origin,
      CAKE_HOME: join(directory, "cake"),
      CAKE_ELECTRON_USER_DATA: join(directory, "electron"),
      PI_CODING_AGENT_DIR: join(directory, "pi"),
      CAKE_ELECTRON_SMOKE: "1",
      CAKE_RST_DEVTOOLS_SMOKE: "1",
    },
  });
  try {
    const page = await application.firstWindow();
    await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeVisible({
      timeout: 90_000,
    });
    const extensionNames = await application.evaluate(({ session }) =>
      session.defaultSession.extensions.getAllExtensions().map((extension) => extension.name),
    );
    expect(extensionNames).toContain("RStateTree DevTools");
    expect(
      await application.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().every((window) => !window.isVisible() && !window.isFocused()),
      ),
    ).toBe(true);
    const opened = application.waitForEvent("window");
    await application.evaluate(({ BrowserWindow }) => {
      const target = BrowserWindow.getAllWindows()[0]!;
      const tools = new BrowserWindow({ show: false });
      target.webContents.setDevToolsWebContents(tools.webContents);
      target.webContents.openDevTools({ mode: "detach", activate: false });
    });
    const devtools = await opened;
    await expect(devtools).toHaveURL(/^devtools:/);
    await expect(devtools.getByRole("tab", { name: "Elements", exact: true })).toBeVisible();
    // Test-only DevTools frontend navigation avoids native input dispatch to a
    // deliberately hidden tools window. Wait for actual extension registration.
    const registeredPanel = `(async () => {
      const UI = await import('./ui/legacy/legacy.js');
      return UI.InspectorView.InspectorView.instance().tabbedPane.tabIds()
        .find(id => id.startsWith('chrome-extension://') && id.endsWith('RStateTree'));
    })()`;
    await expect.poll(() => devtools.evaluate(registeredPanel), { timeout: 30_000 }).toBeTruthy();
    await devtools.evaluate(`(async () => {
      const UI = await import('./ui/legacy/legacy.js');
      const pane = UI.InspectorView.InspectorView.instance().tabbedPane;
      const id = pane.tabIds().find(id => id.startsWith('chrome-extension://') && id.endsWith('RStateTree'));
      pane.selectTab(id);
    })()`);
    const panel = devtools.frameLocator('iframe[src$="/panel.html"]');
    await expect(panel.getByRole("button", { name: /RootStore/ })).toBeVisible({ timeout: 30_000 });
    await expect(panel.locator("#mode")).toContainText("Read-only");
    await expect(panel.getByRole("checkbox", { name: "Evaluate computeds" })).not.toBeChecked();
    await panel.getByRole("button", { name: /AppShell/ }).dispatchEvent("click");
    await expect(panel.locator('[data-field="workspace"]')).toContainText("cake-chat");
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await panel.getByRole("button", { name: "Reconnect / refresh" }).dispatchEvent("click");
    await expect(panel.locator('[data-field="workspace"]')).toContainText("settings");
    expect(
      await application.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().every((window) => !window.isVisible() && !window.isFocused()),
      ),
    ).toBe(true);
    await devtools.screenshot({ path: test.info().outputPath("r-state-tree-panel.png") });

    if (holdDirectory) {
      await writeFile(join(holdDirectory, "ready"), JSON.stringify({ origin, directory }));
      const exists = async (name: string) =>
        access(join(holdDirectory, name)).then(
          () => true,
          () => false,
        );
      const deadline = Date.now() + 600_000;
      while (!(await exists("release")) && Date.now() < deadline) {
        if (await exists("restart")) {
          await rm(join(holdDirectory, "restart"));
          await server.close();
          server = await createServer(config.renderer);
          await server.listen();
          await page.reload();
          await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeVisible({
            timeout: 60_000,
          });
          await writeFile(join(holdDirectory, "reconnected"), "ready");
        }
        await new Promise((done) => setTimeout(done, 250));
      }
    }
  } finally {
    await application.close();
    await server.close();
    await rm(outDir, { recursive: true, force: true });
    await rm(directory, { recursive: true, force: true });
  }
});
