import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";

const repositoryRoot = resolve(import.meta.dirname, "../..");

test("presents durable artifacts, sorts a table, resolves a form, and isolates HTML", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "cake-s4-smoke-"));
  const userData = join(temporaryRoot, "user-data");
  const project = join(temporaryRoot, "project");
  await Promise.all([mkdir(userData, { recursive: true }), mkdir(project, { recursive: true })]);
  await writeFile(join(userData, "window-state.json"), JSON.stringify({ projectPath: project, recentProjectPaths: [project], draft: "", theme: "system", thinkingExpanded: false }));
  await writeFile(join(userData, "application.json"), JSON.stringify({ schemaVersion: 1, projects: [{ path: project, name: "project", addedAt: new Date(0).toISOString(), lastOpenedAt: new Date(0).toISOString(), archivedSessionIds: [] }], trustedProjectPaths: [] }));
  const launch = () => electron.launch({ args: [repositoryRoot], cwd: repositoryRoot, env: { ...process.env, CAKE_ELECTRON_SMOKE: "1", CAKE_ELECTRON_USER_DATA: userData } });
  let application: ElectronApplication | undefined;

  try {
    application = await launch();
    let page = await application.firstWindow();
    await expect(page.getByLabel("Message")).toBeVisible({ timeout: 20_000 });
    await page.getByLabel("Message").fill("/cake-artifacts");
    await page.getByRole("button", { name: "Send" }).click();

    const table = page.locator('[data-artifact-id="cake-s4-table"]');
    await expect(table).toBeVisible();
    await expect(table.locator(".artifact-table tbody td").allTextContents()).resolves.toEqual(["", "Alpha", "2", "", "Beta", "1"]);
    await table.getByRole("button", { name: "Score" }).click();
    await expect(table.locator(".artifact-table tbody td").allTextContents()).resolves.toEqual(["", "Beta", "1", "", "Alpha", "2"]);

    const form = page.locator('[data-artifact-id="cake-s4-form"]');
    await form.getByLabel("Answer *").fill("structured answer");
    await form.getByRole("button", { name: "Send response" }).click();
    await expect(form.getByRole("button", { name: "Send response" })).not.toBeAttached();
    await expect(form.locator("header span")).toContainText("r2");

    const html = page.locator('[data-artifact-id="cake-s4-html"] iframe');
    await expect(html).toHaveAttribute("sandbox", "");
    await expect(html).toHaveAttribute("srcdoc", /default-src 'none'/);
    await expect(page.locator("body")).not.toContainText("compromised");
    await expect(page.locator('[data-artifact-id="cake-s4-diagram"] iframe')).toBeVisible();
    await expect.poll(async () => {
      const state = JSON.parse(await readFile(join(userData, "window-state.json"), "utf8")) as { selectedSessionId?: string; selectedSessionFile?: string };
      return Boolean(state.selectedSessionId && state.selectedSessionFile);
    }).toBe(true);

    await application.close(); application = undefined;
    application = await launch();
    page = await application.firstWindow();
    await expect(page.getByLabel("Message")).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('[data-artifact-id="cake-s4-table"]')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('[data-artifact-id="cake-s4-diagram"] iframe')).toBeVisible();
    await expect(page.getByText("Agent → Artifact → User", { exact: true })).toBeAttached();
  } finally {
    await application?.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
