import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "../../scripts/queued-electron.mjs";
import { expect, test } from "@playwright/test";
import { seedAutomationVisualFixture } from "../fixtures/automations";

const repositoryRoot = resolve(import.meta.dirname, "../..");
async function launchAutomationFixture(theme: "light" | "dark" = "light") {
  const directory = await mkdtemp(join(tmpdir(), "cake-automation-ui-"));
  const paths = {
    cakeHome: join(directory, "home"),
    project: join(directory, "project"),
    userData: join(directory, "user-data"),
  };
  const cleanup = await seedAutomationVisualFixture(paths, theme);
  let application: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    application = await electron.launch({
      args: [repositoryRoot],
      cwd: repositoryRoot,
      env: {
        ...process.env,
        CAKE_ELECTRON_SMOKE: "1",
        CAKE_ELECTRON_USER_DATA: paths.userData,
        CAKE_HOME: paths.cakeHome,
        PI_CODING_AGENT_DIR: join(paths.cakeHome, "pi"),
        PI_CODING_AGENT_SESSION_DIR: "",
      },
    });
    const page = await application.firstWindow();
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setContentSize(1440, 1000),
    );
    await expect(page.getByRole("heading", { name: "Automations", exact: true })).toBeVisible();
    await expect(
      page
        .getByRole("table", { name: "Automations", exact: true })
        .getByRole("button", { name: "Morning brief", exact: true }),
    ).toBeVisible();
    return {
      page,
      paths,
      modelRequests: cleanup.requestCount,
      async close() {
        await application?.close();
        await cleanup();
        await rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await application?.close();
    await cleanup();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

test("chooses the project once and limits event options to that project or Global", async () => {
  const fixture = await launchAutomationFixture();
  const { page } = fixture;
  try {
    await page.getByRole("button", { name: "New automation", exact: true }).click();
    await page
      .getByRole("combobox", { name: "Project", exact: true })
      .selectOption(fixture.paths.project, { timeout: 3000 });
    await page.getByRole("button", { name: "Event", exact: true }).click();
    await page.getByRole("button", { name: "Filter events", exact: true }).click();
    const trigger = page.getByRole("region", { name: "Trigger", exact: true });
    await expect(trigger.getByRole("button", { name: "Project Chat", exact: true })).toBeVisible();
    await expect(trigger.getByRole("button", { name: "Cake Chat", exact: true })).toHaveCount(0);
    await page.getByRole("combobox", { name: "Project", exact: true }).selectOption("global");
    await expect(trigger.getByRole("button", { name: "Project Chat", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.getByRole("table", { name: "Automations", exact: true })).toBeVisible();
    expect(fixture.modelRequests()).toBe(0);
  } finally {
    await fixture.close();
  }
});

test("cancels creation and returns to the automation list without saving", async () => {
  const fixture = await launchAutomationFixture();
  const { page } = fixture;
  try {
    for (const triggerKind of ["Schedule", "Event"]) {
      await page.getByRole("button", { name: "New automation", exact: true }).click();
      const name = page.getByRole("textbox", { name: "Automation name", exact: true });
      await expect(name).toHaveValue("New automation");
      await name.fill("Discard this automation");
      await page.getByRole("button", { name: triggerKind, exact: true }).click();
      const cancel = page.getByRole("button", { name: "Cancel", exact: true });
      await expect(cancel).toBeVisible({ timeout: 3000 });
      await cancel.click();
      const list = page.getByRole("table", { name: "Automations", exact: true });
      await expect(list).toBeVisible();
      await expect(list.getByRole("button", { name: "Morning brief", exact: true })).toBeVisible();
      await expect(
        list.getByRole("button", { name: "Discard this automation", exact: true }),
      ).toHaveCount(0);
    }
    expect(fixture.modelRequests()).toBe(0);
  } finally {
    await fixture.close();
  }
});

test("creates through native inputs and model popover, runs a real Automation Session, and preserves composer focus/input", async () => {
  test.setTimeout(90000);
  const fixture = await launchAutomationFixture();
  const { page } = fixture;
  try {
    await page.getByRole("button", { name: "New automation", exact: true }).click();
    const name = page.getByRole("textbox", { name: "Automation name", exact: true });
    await name.focus();
    await name.press("Meta+A");
    await name.pressSequentially("Evening review");
    await expect(name).toHaveValue("Evening review");
    await page
      .getByRole("combobox", { name: "Project", exact: true })
      .selectOption(fixture.paths.project);
    await page
      .getByRole("combobox", { name: "Schedule repeat", exact: true })
      .selectOption("Calendar");
    await page
      .getByRole("combobox", { name: "Calendar recurrence", exact: true })
      .selectOption("weekdays");
    const zone = page.getByRole("textbox", { name: "Calendar time zone", exact: true });
    await zone.focus();
    await zone.press("Meta+A");
    await zone.pressSequentially("America/Los_Angeles");
    await expect(zone).toHaveValue("America/Los_Angeles");
    const task = page.getByRole("textbox", { name: "Automation task", exact: true });
    await task.focus();
    await task.pressSequentially("Review the project and retain important decisions.");
    await expect(task).toBeFocused();
    await expect(task).toHaveValue("Review the project and retain important decisions.");
    await page.getByRole("button", { name: "Automation model", exact: true }).click();
    await expect(page.getByRole("dialog").last()).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "Automation model", exact: true })).toBeFocused();
    await page.getByRole("radio", { name: "Paused", exact: true }).check();
    const queue = page.getByRole("radio", { name: "Queue", exact: true });
    await queue.check();
    await queue.focus();
    await queue.press("ArrowRight");
    await expect(page.getByRole("radio", { name: "Run in parallel", exact: true })).toBeChecked();
    await page.getByRole("radio", { name: "Run in parallel", exact: true }).press("ArrowLeft");
    await expect(queue).toBeChecked();
    await page.getByRole("radio", { name: "Keep for review", exact: true }).check();
    const create = page.getByRole("button", { name: "Create automation", exact: true });
    await expect(create).toBeEnabled();
    await create.click();
    await expect(page.getByRole("button", { name: "Save changes", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Run now", exact: true }).click();
    await expect(
      page.getByText("Reviewing the latest project changes and shared automation memory.", {
        exact: true,
      }),
    ).toBeVisible();
    const composer = page.getByRole("combobox", { name: "Message automation run", exact: true });
    await composer.focus();
    await composer.pressSequentially("Keep this follow-up in the same run.");
    await expect(composer).toBeFocused();
    await expect(composer).toHaveValue("Keep this follow-up in the same run.");
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Automation", exact: true }).click();
    const archive = page.getByRole("button", { name: "Archive", exact: true });
    await archive.click();
    const dialog = page.getByRole("dialog", { name: "Archive automation", exact: true });
    await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeAttached();
    await expect(archive).toBeFocused();
    await page
      .getByRole("complementary")
      .getByRole("button", { name: /^Evening review/ })
      .click();
    await expect(composer).toHaveValue("Keep this follow-up in the same run.");
    await composer.clear();
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await expect(page.getByRole("button", { name: "Resolve", exact: true })).toBeEnabled();
    await expect(page.locator('[data-slot="automation-session"]')).toContainText("Needs review");
  } finally {
    await fixture.close();
  }
});

test("global history and shared memory open real originals; restore is visibility-only and window navigation retains each run", async () => {
  test.setTimeout(90000);
  const fixture = await launchAutomationFixture("dark");
  const { page } = fixture;
  try {
    await page
      .getByRole("table", { name: "Automations", exact: true })
      .getByRole("button", { name: "Morning brief", exact: true })
      .click();
    await page
      .getByRole("navigation", { name: "Automation panes" })
      .getByRole("button", { name: "Memory", exact: true })
      .click();
    await page.getByRole("button", { name: "Zoom", exact: true }).first().click();
    const original = page.getByRole("heading", { name: /Original/ });
    await expect(original).toBeVisible();
    await page.getByRole("button", { name: "Load more original", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Load more original", exact: true }),
    ).not.toBeAttached();
    await page.getByRole("button", { name: "All automations", exact: true }).click();
    await page.getByRole("button", { name: "History", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Automation history", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Open run", exact: true }).first().click();
    await expect(
      page.getByText(
        "The review is complete. Shared memory retains recurring decisions and unresolved work.",
        { exact: true },
      ),
    ).toBeVisible();
    await page.getByRole("button", { name: "Resolve", exact: true }).click();
    await expect(page.getByRole("button", { name: "Unresolve", exact: true })).toBeVisible();
    await expect(page.locator('[data-slot="workspace-header"]')).toContainText(
      "Review child replies",
    );
    await page.getByRole("button", { name: "Unresolve", exact: true }).click();
    await expect(page.getByRole("button", { name: "Resolve", exact: true })).toBeVisible();
    expect(fixture.modelRequests()).toBe(0);
    await expect(page.getByRole("button", { name: "Mark unread", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Mark unread", exact: true }).click();
    await expect(page.getByRole("button", { name: "Mark read", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Mark read", exact: true }).click();
    await expect(page.getByRole("button", { name: "Mark unread", exact: true })).toBeVisible();
    const composer = page.getByRole("combobox", { name: "Message automation run", exact: true });
    await composer.focus();
    await composer.pressSequentially("Follow-up without rerunning the automation");
    await expect(composer).toBeFocused();
    await expect(composer).toHaveValue("Follow-up without rerunning the automation");
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
    const sidebar = page.locator('[data-slot="sidebar-automations"]');
    await sidebar.getByRole("button", { name: /Morning brief/ }).click();
    await page.getByRole("button", { name: "Go back in session history", exact: true }).click();
    await expect(page.locator('[data-slot="workspace-header"]')).toContainText(
      "Review child replies",
    );
    await page.getByRole("button", { name: "Go forward in session history", exact: true }).click();
    await expect(page.locator('[data-slot="workspace-header"]')).toContainText("Morning brief");
    await page.getByRole("button", { name: "Automation", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Morning brief", exact: true })).toBeVisible();
  } finally {
    await fixture.close();
  }
});
