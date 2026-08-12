import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const repositoryRoot = resolve(import.meta.dirname, "../..");

test("keeps window state independent across Pi sessions", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "cake-s2-smoke-"));
  const userData = join(temporaryRoot, "user-data");
  const project = join(temporaryRoot, "project");
  await Promise.all([mkdir(userData, { recursive: true }), mkdir(project, { recursive: true })]);
  const base = { projectPath: project, recentProjectPaths: [project], theme: "system", thinkingExpanded: false, sessionSearch: "", draftsBySession: {} };
  await Promise.all([
    writeFile(join(userData, "window-state.json"), JSON.stringify({ ...base, draft: "first window draft" })),
    writeFile(join(userData, "window-state-1.json"), JSON.stringify({ ...base, draft: "second window draft" })),
    writeFile(join(userData, "application.json"), JSON.stringify({ schemaVersion: 1, projects: [{ path: project, name: "project", addedAt: new Date(0).toISOString(), lastOpenedAt: new Date(0).toISOString(), archivedSessionIds: [] }], trustedProjectPaths: [] }))
  ]);
  const application = await electron.launch({ args: [repositoryRoot], cwd: repositoryRoot, env: { ...process.env, CAKE_ELECTRON_SMOKE: "1", CAKE_ELECTRON_USER_DATA: userData } });
  try {
    const first = await application.firstWindow();
    await expect(first.getByLabel("Message")).toHaveValue("first window draft", { timeout: 20_000 });
    await first.evaluate(() => window.cake?.request({ type: "new-window" }));
    await expect.poll(() => application.windows().length).toBe(2);
    const second = application.windows().find((page) => page !== first)!;
    await expect(second.getByLabel("Message")).toHaveValue("second window draft", { timeout: 20_000 });

    const firstSession = await first.locator(".workspace").getAttribute("data-session-id");
    await second.getByRole("button", { name: "New chat in project" }).click();
    await expect.poll(() => second.locator(".workspace").getAttribute("data-session-id")).not.toBe(firstSession);
    await expect(first.getByLabel("Message")).toHaveValue("first window draft");

    await expect(first.getByRole("navigation", { name: "Workspace surfaces" })).toHaveCount(0);
  } finally {
    await application.evaluate(() => { const reset = Reflect.get(globalThis, "cakeSmokeResetPi"); if (typeof reset === "function") reset(); });
    await application.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
