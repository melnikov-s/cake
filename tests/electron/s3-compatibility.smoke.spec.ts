import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const repositoryRoot = resolve(import.meta.dirname, "../..");

test("adapts extension dialogs and reports unsupported widgets", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "cake-s3-smoke-"));
  const userData = join(temporaryRoot, "user-data");
  const project = join(temporaryRoot, "project");
  const fixturePackage = join(project, "fixture-package");
  await Promise.all([
    mkdir(userData, { recursive: true }),
    mkdir(join(project, ".pi"), { recursive: true }),
    mkdir(join(fixturePackage, "extensions"), { recursive: true }),
    mkdir(join(fixturePackage, "skills", "desktop-fixture"), { recursive: true }),
    mkdir(join(fixturePackage, "prompts"), { recursive: true })
  ]);
  await writeFile(join(userData, "window-state.json"), JSON.stringify({ projectPath: project, recentProjectPaths: [project], draft: "", theme: "system", thinkingExpanded: false }));
  await writeFile(join(userData, "application.json"), JSON.stringify({ schemaVersion: 1, projects: [{ path: project, name: "project", addedAt: new Date(0).toISOString(), lastOpenedAt: new Date(0).toISOString(), archivedSessionIds: [] }], trustedProjectPaths: [project] }));
  await writeFile(join(project, ".pi", "settings.json"), JSON.stringify({ packages: ["../fixture-package"] }));
  await writeFile(join(fixturePackage, "package.json"), JSON.stringify({ name: "desktop-fixture", version: "1.0.0", pi: { extensions: ["extensions/desktop-fixture.ts"], skills: ["skills"], prompts: ["prompts"] } }));
  await writeFile(join(fixturePackage, "skills", "desktop-fixture", "SKILL.md"), "---\nname: desktop-fixture\ndescription: Desktop fixture skill\n---\nFixture.\n");
  await writeFile(join(fixturePackage, "prompts", "desktop-fixture.md"), "---\ndescription: Desktop fixture prompt\n---\nFixture.\n");
  await writeFile(join(fixturePackage, "extensions", "desktop-fixture.ts"), `
export default function (pi) {
  pi.registerCommand("desktop-fixture", { description: "Exercise Cake desktop UI", async handler(_args, ctx) {
    ctx.ui.notify("Extension connected", "info");
    ctx.ui.setStatus("fixture", "ready");
    ctx.ui.setTitle("Extension workspace");
    ctx.ui.setWidget("fixture", ["unsupported widget line"], { placement: "aboveEditor" });
    ctx.ui.setEditorText("draft from extension");
    await ctx.ui.confirm("Desktop extension", "Confirm the compatibility path");
    ctx.ui.setFooter(() => ({ render: () => [], invalidate() {} }));
  } });
}
`);

  const application = await electron.launch({
    args: [repositoryRoot], cwd: repositoryRoot,
    env: { ...process.env, CAKE_ELECTRON_SMOKE: "1", CAKE_ELECTRON_USER_DATA: userData, CAKE_HOME: join(temporaryRoot, "cake-home") }
  });

  try {
    const page = await application.firstWindow();
    const rendererErrors: string[] = [];
    page.on("pageerror", (error) => rendererErrors.push(error.message));
    await expect(page.getByLabel("Message")).toBeVisible({ timeout: 20_000 });
    expect(rendererErrors).toEqual([]);
    await page.getByLabel("Message").fill("/desktop-fixture");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByText("Desktop extension", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Confirm", exact: true }).click();
    await expect(page.locator(".workspace-header strong")).toHaveText("Extension workspace");
    await expect(page.getByText(/setWidget is unavailable in Cake/)).toBeVisible();
    await expect(page.getByText("Extension connected", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Message")).toHaveValue("draft from extension");
    await expect(page.getByText("fixture ready", { exact: true })).toBeVisible();
  } finally {
    await application.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
