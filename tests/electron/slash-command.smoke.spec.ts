import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const repositoryRoot = resolve(import.meta.dirname, "../..");

test("selects and runs slash commands from the composer with the keyboard", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "cake-slash-command-smoke-"));
  const userData = join(temporaryRoot, "user-data");
  const project = join(temporaryRoot, "project");
  const skillDirectory = join(project, ".agents", "skills", "desktop-fixture");
  await Promise.all([
    mkdir(userData, { recursive: true }),
    mkdir(skillDirectory, { recursive: true }),
  ]);
  await writeFile(
    join(skillDirectory, "SKILL.md"),
    "---\nname: desktop-fixture\ndescription: Desktop fixture skill\n---\nFixture.\n",
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
      trustedProjectPaths: [project],
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

    const initialHeight = await composer.evaluate((input) => input.getBoundingClientRect().height);
    expect(initialHeight).toBeLessThanOrEqual(48);

    await composer.click();
    await expect(composer).toBeFocused();
    await composer.pressSequentially("hello");
    await expect(composer).toHaveValue("hello");
    await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();

    await composer.fill(Array.from({ length: 30 }, (_, index) => `Line ${index + 1}`).join("\n"));
    const expandedSize = await composer.evaluate((input) => ({
      height: input.getBoundingClientRect().height,
      scrollHeight: input.scrollHeight,
    }));
    expect(expandedSize.height).toBeGreaterThan(initialHeight);
    expect(expandedSize.height).toBeLessThanOrEqual(321);
    expect(expandedSize.scrollHeight).toBeGreaterThan(expandedSize.height);

    await composer.fill("/");
    await expect(page.getByRole("listbox", { name: "Slash commands" })).toBeVisible();
    await expect(page.getByRole("option", { name: /compact/ })).toHaveCount(0);
    await expect(page.getByRole("option", { name: /handoff/ })).toHaveCount(0);
    await composer.press("Tab");
    await expect(composer).toHaveValue("/model ");

    await composer.fill("/tree");
    await composer.press("Enter");
    await expect(page.getByRole("complementary", { name: "Session tree" })).toBeVisible();

    await page.getByRole("button", { name: "New chat in project", exact: true }).click();
    await composer.fill("/skill:desktop");
    await expect(
      page.getByRole("option", { name: /skill:desktop-fixture Desktop fixture skill/ }),
    ).toBeVisible();
    await composer.press("Tab");
    await expect(composer).toHaveValue("/skill:desktop-fixture ");
    await composer.press("Enter");
    await expect(page.locator(".session-item.active")).toHaveCount(1, { timeout: 20_000 });
    await expect(composer).toHaveValue("");
  } finally {
    await application.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
