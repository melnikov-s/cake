import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const repositoryRoot = resolve(import.meta.dirname, "../..");

test("reorders projects by dragging in the desktop sidebar", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "cake-sidebar-project-reorder-smoke-"));
  const userData = join(temporaryRoot, "user-data");
  const cakeHome = join(temporaryRoot, "cake-home");
  const firstProject = join(temporaryRoot, "alpha");
  const secondProject = join(temporaryRoot, "beta");
  const timestamp = new Date(0).toISOString();
  await Promise.all([
    mkdir(userData, { recursive: true }),
    mkdir(join(cakeHome, "state"), { recursive: true }),
    mkdir(firstProject, { recursive: true }),
    mkdir(secondProject, { recursive: true }),
  ]);
  await writeFile(
    join(userData, "window-state.json"),
    JSON.stringify({ recentProjectPaths: [firstProject, secondProject], theme: "system" }),
  );
  await writeFile(
    join(cakeHome, "state", "application.json"),
    JSON.stringify({
      schemaVersion: 1,
      projects: [firstProject, secondProject].map((path) => ({
        path,
        name: basename(path),
        addedAt: timestamp,
        lastOpenedAt: timestamp,
      })),
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
      CAKE_HOME: cakeHome,
    },
  });

  try {
    const page = await application.firstWindow();
    const labels = page.locator('[data-slot="project-group"] [data-slot="project-label"]');
    await expect(labels).toHaveText(["alpha", "beta"], { timeout: 20_000 });

    const sortButton = page.getByRole("button", { name: "Sort sessions in alpha" });
    await sortButton.click();
    const sortMenu = page.getByRole("menu", { name: "Sort sessions in alpha" });
    await expect(sortMenu.getByRole("menuitemradio", { name: "By date" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await sortMenu.getByRole("menuitemradio", { name: "By label" }).click();
    await sortButton.click();
    await expect(sortMenu.getByRole("menuitemradio", { name: "By label" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await page.keyboard.press("Escape");

    const source = await labels.nth(1).boundingBox();
    const target = await labels.nth(0).boundingBox();
    expect(source).not.toBeNull();
    expect(target).not.toBeNull();
    await page.mouse.move(source!.x + 5, source!.y + source!.height / 2);
    await page.mouse.down();
    await page.mouse.move(target!.x + 5, target!.y + 1, { steps: 8 });
    await page.mouse.up();

    await expect(labels).toHaveText(["beta", "alpha"]);
  } finally {
    await application.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
