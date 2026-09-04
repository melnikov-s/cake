import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const repositoryRoot = resolve(import.meta.dirname, "../..");

test("splits project chats while retaining independent drafts and pane focus", async () => {
  test.setTimeout(60_000);
  const temporaryRoot = await mkdtemp(join(tmpdir(), "cake-session-split-"));
  const userData = join(temporaryRoot, "user-data");
  const project = join(temporaryRoot, "project");
  const cakeHome = join(temporaryRoot, "cake-home");
  await Promise.all([
    mkdir(userData, { recursive: true }),
    mkdir(project, { recursive: true }),
    mkdir(join(cakeHome, "state"), { recursive: true }),
  ]);
  await writeFile(
    join(userData, "window-state.json"),
    JSON.stringify({ projectPath: project, recentProjectPaths: [project], draft: "" }),
  );
  await writeFile(
    join(cakeHome, "state", "application.json"),
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
    const panes = page.locator('[data-slot="session-pane"]');
    await expect(panes).toHaveCount(1, { timeout: 20_000 });
    await expect(panes.nth(0).getByRole("button", { name: "Close pane" })).toHaveCount(0);
    await expect(page.locator('[data-slot="workspace-header"]')).toHaveCount(1);
    const firstInput = panes.nth(0).getByLabel("Message");
    await firstInput.fill("left draft");

    await panes.nth(0).getByRole("button", { name: "Split right" }).click();
    await expect(panes).toHaveCount(2);
    await expect(page.locator('[data-slot="workspace-header"]')).toHaveCount(2);
    await expect(panes.nth(1)).toHaveAttribute("data-focused", "true");
    const secondInput = panes.nth(1).getByLabel("Message");
    await expect(secondInput).toBeFocused();
    await secondInput.fill("right draft");

    await panes.nth(0).locator("header").click();
    await expect(panes.nth(0)).toHaveAttribute("data-focused", "true");
    await expect(firstInput).toHaveValue("left draft");
    await expect(secondInput).toHaveValue("right draft");

    const focusedPane = page.locator('[data-slot="session-pane"][data-focused="true"]');
    await focusedPane.getByRole("button", { name: "Split down" }).click();
    await expect(panes).toHaveCount(3);

    const rightPane = panes.nth(2);
    await rightPane.locator('[data-slot="chat"]').click({ position: { x: 24, y: 80 } });
    await expect(rightPane).toHaveAttribute("data-focused", "true");

    await panes.nth(0).locator("header").click();
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+Alt+ArrowRight" : "Control+Alt+ArrowRight",
    );
    await expect(rightPane).toHaveAttribute("data-focused", "true");

    await focusedPane.getByRole("button", { name: "Close pane" }).click();
    await expect(panes).toHaveCount(2);
  } finally {
    await application.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
