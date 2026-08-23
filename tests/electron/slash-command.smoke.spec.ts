import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const repositoryRoot = resolve(import.meta.dirname, "../..");

test("selects and runs slash commands from the composer with the keyboard", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "cake-slash-command-smoke-"));
  const userData = join(temporaryRoot, "user-data");
  const project = join(temporaryRoot, "project");
  await import("node:fs/promises").then(({ mkdir }) =>
    Promise.all([mkdir(userData, { recursive: true }), mkdir(project, { recursive: true })]),
  );
  await writeFile(
    join(userData, "window-state.json"),
    JSON.stringify({
      projectPath: project,
      recentProjectPaths: [project],
      draft: "",
      theme: "system",
    }),
  );
  await writeFile(
    join(userData, "application.json"),
    JSON.stringify({
      schemaVersion: 1,
      projects: [
        {
          path: project,
          name: "project",
          addedAt: new Date(0).toISOString(),
          lastOpenedAt: new Date(0).toISOString(),
        },
      ],
      resolvedSessionIds: [],
      trustedProjectPaths: [],
    }),
  );

  const application = await electron.launch({
    args: [repositoryRoot],
    cwd: repositoryRoot,
    env: {
      ...process.env,
      CAKE_ELECTRON_SMOKE: "1",
      CAKE_ELECTRON_USER_DATA: userData,
      CAKE_HOME: join(temporaryRoot, "cake-home"),
    },
  });

  try {
    const page = await application.firstWindow();
    const composer = page.getByLabel("Message");
    await expect(composer).toBeVisible({ timeout: 20_000 });

    await composer.fill("/");
    await expect(page.getByRole("listbox", { name: "Slash commands" })).toBeVisible();
    await composer.press("ArrowDown");
    await composer.press("Tab");
    await expect(composer).toHaveValue("/model ");

    await composer.fill("/tree");
    await composer.press("Enter");
    await expect(page.getByRole("complementary", { name: "Session tree" })).toBeVisible();
  } finally {
    await application.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
