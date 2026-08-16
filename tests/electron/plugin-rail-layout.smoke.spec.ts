import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const repositoryRoot = resolve(import.meta.dirname, "../..");

test("keeps session plugin rails beside the chat and bounds plugin-authored width", async () => {
  test.setTimeout(90_000);
  const temporaryRoot = await mkdtemp(join(tmpdir(), "cake-plugin-rail-"));
  const cakeHome = join(temporaryRoot, "cake-home");
  const userData = join(temporaryRoot, "user-data");
  const project = join(temporaryRoot, "project");
  await Promise.all([mkdir(userData, { recursive: true }), mkdir(project, { recursive: true })]);
  await Promise.all([
    writeFile(join(userData, "window-state.json"), JSON.stringify({ projectPath: project, recentProjectPaths: [project], draft: "", theme: "system", thinkingExpanded: false })),
    writeFile(join(userData, "application.json"), JSON.stringify({ schemaVersion: 1, projects: [{ path: project, name: "project", addedAt: new Date(0).toISOString(), lastOpenedAt: new Date(0).toISOString(), archivedSessionIds: [] }], trustedProjectPaths: [] }))
  ]);

  const application = await electron.launch({ args: [repositoryRoot], cwd: repositoryRoot, env: { ...process.env, CAKE_ELECTRON_SMOKE: "1", CAKE_ELECTRON_USER_DATA: userData, CAKE_HOME: cakeHome } });
  try {
    const page = await application.firstWindow();
    await expect(page.getByLabel("Message")).toBeVisible({ timeout: 20_000 });
    await page.evaluate(() => {
      document.querySelector<HTMLElement>(".app-shell")?.style.setProperty("--sidebar-width", "230px");
      const slot = document.querySelector(".project-session-plugin-rail-right .project-session-rail-slot-top");
      if (!slot) throw new Error("Right session rail is unavailable");
      const panel = document.createElement("section");
      panel.id = "rail-panel";
      panel.textContent = "Environment";
      panel.style.cssText = "box-sizing:border-box;width:430px;height:280px;padding:20px";
      slot.append(panel);
    });
    await expect(page.locator("#rail-panel")).toBeVisible({ timeout: 20_000 });

    const measure = () => page.evaluate(() => {
      const chat = document.querySelector(".project-session-workbench > .chat-layout")!.getBoundingClientRect();
      const rail = document.querySelector(".project-session-plugin-rail-right")!.getBoundingClientRect();
      const panel = document.querySelector("#rail-panel")!.getBoundingClientRect();
      return { viewportWidth: innerWidth, chat: { top: chat.top, right: chat.right, bottom: chat.bottom }, rail: { top: rail.top, left: rail.left, right: rail.right, bottom: rail.bottom, width: rail.width }, panel: { left: panel.left, right: panel.right, width: panel.width }, documentFits: document.documentElement.scrollWidth <= document.documentElement.clientWidth };
    });

    await page.setViewportSize({ width: 920, height: 720 });
    await expect.poll(measure).toMatchObject({ documentFits: true });
    let layout = await measure();
    expect(layout.rail.top).toBeGreaterThanOrEqual(layout.chat.bottom - 1);
    expect(Math.abs(layout.rail.right - layout.viewportWidth)).toBeLessThanOrEqual(1);
    expect(layout.panel.right).toBeLessThanOrEqual(layout.rail.right - 11);
    expect(layout.panel.width).toBeLessThan(layout.rail.width);

    await page.setViewportSize({ width: 1600, height: 900 });
    layout = await measure();
    expect(layout.rail.left).toBeGreaterThanOrEqual(layout.chat.right - 1);
    expect(layout.rail.width).toBeGreaterThanOrEqual(280);
    expect(layout.rail.width).toBeLessThanOrEqual(336);
    expect(Math.abs(layout.rail.right - layout.viewportWidth)).toBeLessThanOrEqual(1);
    expect(layout.panel.right).toBeLessThanOrEqual(layout.rail.right - 11);

    await page.setViewportSize({ width: 760, height: 720 });
    layout = await measure();
    expect(layout.rail.top).toBeGreaterThanOrEqual(layout.chat.bottom - 1);
    expect(layout.documentFits).toBe(true);
  } finally {
    await application.evaluate(() => { const reset = Reflect.get(globalThis, "cakeSmokeResetPi"); if (typeof reset === "function") reset(); });
    await application.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
