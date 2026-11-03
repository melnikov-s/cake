import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { windowState } from "../fixtures/window-state";

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
  await writeFile(join(userData, "window-state.json"), windowState({ project }));
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
      CAKE_HOME: cakeHome,
      PI_CODING_AGENT_DIR: join(cakeHome, "pi"),
      PI_CODING_AGENT_SESSION_DIR: "",
    },
  });

  try {
    const page = await application.firstWindow();
    const panes = page.locator('[data-slot="session-pane"]');
    await expect(panes).toHaveCount(1, { timeout: 20_000 });
    await expect(panes.nth(0).getByRole("button", { name: "Close pane" })).toHaveCount(0);
    await expect(page.locator('[data-slot="workspace-header"]')).toHaveCount(1);
    const firstInput = panes.nth(0).getByRole("combobox", { name: "Message", exact: true });
    await firstInput.click();
    await expect(firstInput).toBeFocused();
    await firstInput.pressSequentially("left draft");
    await expect(firstInput).toHaveValue("left draft");
    await expect(panes.nth(0).getByRole("button", { name: "Send" })).toBeEnabled();
    await panes.nth(0).getByRole("button", { name: "Split right" }).focus();
    await page.keyboard.press("Tab");
    await expect(firstInput).toBeFocused();
    await firstInput.press("Tab");
    await expect(firstInput).toBeFocused();
    await expect(firstInput).toHaveValue("left draft");

    await panes.nth(0).getByRole("button", { name: "Split right" }).click();
    await expect(panes).toHaveCount(2);
    await expect(page.locator('[data-slot="workspace-header"]')).toHaveCount(2);
    await expect(panes.nth(1)).toHaveAttribute("data-focused", "true");
    const secondInput = panes.nth(1).getByRole("combobox", { name: "Message", exact: true });
    await expect(secondInput).toBeFocused();

    const splitHandleBounds = await page
      .getByRole("separator", { name: "Resize session columns" })
      .boundingBox();
    expect(splitHandleBounds).not.toBeNull();
    await page.mouse.move(
      splitHandleBounds!.x + splitHandleBounds!.width / 2,
      splitHandleBounds!.y + splitHandleBounds!.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(0, splitHandleBounds!.y + splitHandleBounds!.height / 2);
    await page.mouse.up();

    const narrowPaneBounds = await panes.nth(0).boundingBox();
    const narrowPaneCloseBounds = await panes
      .nth(0)
      .getByRole("button", { name: "Close pane" })
      .boundingBox();
    expect(narrowPaneBounds).not.toBeNull();
    expect(narrowPaneCloseBounds).not.toBeNull();
    expect(narrowPaneCloseBounds!.x).toBeGreaterThanOrEqual(narrowPaneBounds!.x);
    expect(narrowPaneCloseBounds!.x + narrowPaneCloseBounds!.width).toBeLessThanOrEqual(
      narrowPaneBounds!.x + narrowPaneBounds!.width,
    );

    await panes.nth(1).getByRole("button", { name: "Split right" }).focus();
    await page.keyboard.press("Tab");
    await expect(secondInput).toBeFocused();
    await page.keyboard.type("right draft");
    await expect(secondInput).toHaveValue("right draft");
    await expect(panes.nth(1).getByRole("button", { name: "Send" })).toBeEnabled();

    await panes
      .nth(0)
      .locator('[data-slot="chat"]')
      .click({ position: { x: 24, y: 80 } });
    await expect(panes.nth(0)).toHaveAttribute("data-focused", "true");
    // The focused split wins even if DOM focus is still in the other composer.
    await panes.nth(0).getByRole("button", { name: "Split right" }).focus();
    await page.keyboard.press("Tab");
    await expect(firstInput).toBeFocused();
    await expect(firstInput).toHaveValue("left draft");
    await expect(secondInput).toHaveValue("right draft");

    const focusedPane = page.locator('[data-slot="session-pane"][data-focused="true"]');
    await focusedPane.getByRole("button", { name: "Split down" }).click();
    await expect(panes).toHaveCount(3);

    const rightPane = panes.nth(2);
    await rightPane.locator('[data-slot="chat"]').click({ position: { x: 24, y: 80 } });
    await expect(rightPane).toHaveAttribute("data-focused", "true");

    await panes
      .nth(0)
      .locator('[data-slot="chat"]')
      .click({ position: { x: 24, y: 80 } });
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+Alt+ArrowRight" : "Control+Alt+ArrowRight",
    );
    await expect(rightPane).toHaveAttribute("data-focused", "true");

    await focusedPane.getByRole("button", { name: "Close pane" }).click();
    await expect(panes).toHaveCount(2);

    // Permanent Project Chat participates in the same layout, using its canonical identity.
    await page.getByRole("button", { name: "Open Project Chat for project" }).click();
    const projectPane = page.locator(
      '[data-slot="session-pane"][data-session-id^="project-chat:"]',
    );
    await expect(projectPane).toHaveCount(1);
    await expect(panes).toHaveCount(2);
    const projectId = await projectPane.getAttribute("data-session-id");
    expect(projectId).toMatch(/^project-chat:[a-f0-9]{64}$/);
    const projectInput = projectPane.getByLabel("Message Project Chat");
    await expect(projectInput).toBeFocused();
    await projectInput.pressSequentially("Project Chat draft");
    await expect(projectInput).toHaveValue("Project Chat draft");
    await expect(projectPane.getByRole("button", { name: "Send" })).toBeEnabled();
    // Re-enter the same pane history from a regular Project Session.
    const modifier = process.platform === "darwin" ? "Meta" : "Control";
    await page.keyboard.press(`${modifier}+[`);
    await expect(projectPane).toHaveCount(0);
    await page.getByRole("button", { name: "Open Project Chat for project" }).click();
    await expect(projectInput).toBeFocused();
    await projectInput.press("End");
    await page.keyboard.type(" retained");
    await expect(projectInput).toHaveValue("Project Chat draft retained");
    await projectPane.getByRole("button", { name: "Split right" }).click();
    await expect(panes).toHaveCount(3);
    const newPane = page.locator('[data-slot="session-pane"][data-focused="true"]');
    const newInput = newPane.getByLabel("Message", { exact: true });
    await expect(newInput).toBeFocused();
    await newInput.pressSequentially("separate Project Session draft");
    await expect(newInput).toHaveValue("separate Project Session draft");
    await expect(newPane.getByRole("button", { name: "Send" })).toBeEnabled();
    await page.keyboard.press(`${modifier}+Alt+ArrowLeft`);
    await expect(projectInput).toBeFocused();
    await page.keyboard.press(`${modifier}+Alt+ArrowRight`);
    await expect(newInput).toBeFocused();
    // Opening an already visible Project Chat focuses it instead of duplicating it.
    await page.getByRole("button", { name: "Open Project Chat for project" }).click();
    await expect(projectPane).toHaveAttribute("data-focused", "true");
    await expect(projectInput).toBeFocused();
    await expect(projectInput).toHaveValue("Project Chat draft retained");
    await expect(panes).toHaveCount(3);
    await projectPane.getByRole("button", { name: "To-do" }).click();
    await expect(projectPane.getByRole("complementary", { name: "To-do" })).toBeVisible();
    // Narrow panes retain the existing accessory replacement behavior; closing restores the composer.
    await projectPane.getByRole("button", { name: "Close To-do" }).click();
    await expect(projectInput).toBeFocused();
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+Alt+ArrowRight" : "Control+Alt+ArrowRight",
    );
    await expect(newInput).toBeFocused();
    await newPane.getByRole("button", { name: "Close pane" }).click();
    await expect(panes).toHaveCount(2);
    await projectInput.click();
    await projectPane.getByRole("button", { name: "Split down" }).click();
    await expect(panes).toHaveCount(3);
    await expect(newInput).toBeFocused();
    await newPane.getByRole("button", { name: "Close pane" }).click();
    await expect(projectInput).toBeFocused();
    const splitModifier = process.platform === "darwin" ? "Meta" : "Control";
    await page.keyboard.press(`${splitModifier}+Backslash`);
    await expect(panes).toHaveCount(3);
    await expect(newInput).toBeFocused();
    await newPane.getByRole("button", { name: "Close pane" }).click();
    await expect(projectInput).toBeFocused();
    await projectPane.getByRole("button", { name: "Close pane" }).click();
    await expect(panes).toHaveCount(1);
    await expect(panes.nth(0).getByLabel("Message", { exact: true })).toHaveValue("left draft");

    await page.getByRole("button", { name: "New session", exact: true }).click();
    const destinationDialog = page.getByRole("dialog", { name: "New session", exact: true });
    const filter = destinationDialog.getByRole("combobox", { name: "Filter projects" });
    await destinationDialog.getByRole("button", { name: "Close", exact: true }).focus();
    await page.keyboard.press("Tab");
    await expect(filter).toBeFocused();
    await page.keyboard.type("Cake");
    await page.keyboard.press("Tab");
    await expect(filter).toBeFocused();
    await expect(filter).toHaveValue("Cake");
    await page.keyboard.press("Escape");
    await expect(destinationDialog).toHaveCount(0);
    await page.keyboard.press("Tab");
    await expect(panes.nth(0).getByLabel("Message", { exact: true })).toBeFocused();
    await page.getByRole("button", { name: "New session", exact: true }).click();
    await page.getByRole("option", { name: /Cake Chat/ }).click();
    await expect(panes).toHaveCount(1);
    const cakeInput = panes.nth(0).getByLabel("Message Cake Chat");
    await expect(cakeInput).toBeFocused();
    await cakeInput.pressSequentially("Cake Chat draft");
    await expect(cakeInput).toHaveValue("Cake Chat draft");
    await expect(panes.nth(0).getByRole("button", { name: "Send" })).toBeEnabled();

    // Pane commands use the selected conversation's layout, not the retained Project layout.
    await page.keyboard.press(`${modifier}+1`);
    await page.keyboard.press(`${modifier}+Backslash`);
    await expect(panes).toHaveCount(1);
    await expect(cakeInput).toHaveValue("Cake Chat draft");
  } finally {
    await application.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
