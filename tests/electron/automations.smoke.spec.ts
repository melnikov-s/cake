import { createHmac, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "../../scripts/queued-electron.mjs";
import { expect, test, type Page } from "@playwright/test";
import { openAutomations, seedAutomationVisualFixture } from "../fixtures/automations";

const repositoryRoot = resolve(import.meta.dirname, "../..");
async function openHistoryRun(page: Page, name: string) {
  // Automations is a full-window application view without the rail; run views keep the rail.
  const rail = page
    .getByRole("navigation", { name: "Projects and global utilities" })
    .getByRole("button", { name: "Automations", exact: true });
  if (await rail.isVisible()) await rail.click();
  const overview = page.getByRole("button", { name: "All automations", exact: true });
  if (await overview.isVisible()) await overview.click();
  await page.getByRole("button", { name: "History", exact: true }).click();
  await page
    .getByRole("region", { name: "Automation run history" })
    .getByRole("row")
    .filter({ hasText: name })
    .getByRole("button", { name: "Open run", exact: true })
    .first()
    .click();
}
async function availableWebhookPort() {
  const socket = createServer();
  socket.listen(0, "127.0.0.1");
  await once(socket, "listening");
  const address = socket.address();
  await new Promise<void>((done) => socket.close(() => done()));
  if (!address || typeof address === "string") throw new Error("No fixture listener port");
  return address.port;
}

async function launchAutomationFixture(
  theme: "light" | "dark" = "light",
  webhook?: { port: number; report: string; reasoning: string },
) {
  const directory = await mkdtemp(join(tmpdir(), "cake-automation-ui-"));
  const paths = {
    cakeHome: join(directory, "home"),
    project: join(directory, "project"),
    userData: join(directory, "user-data"),
  };
  const cleanup = await seedAutomationVisualFixture(paths, theme, webhook);
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
        ...(webhook ? { CAKE_GITHUB_WEBHOOK_PORT: String(webhook.port) } : null),
      },
    });
    const page = await application.firstWindow();
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setContentSize(1440, 1000),
    );
    await openAutomations(page);
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

test("previews a GitHub webhook without running, then opens the signed delivery as inert text", async ({}, testInfo) => {
  const report = "Review approved. ![Not an active image](http://127.0.0.1:1/never-load.png)";
  const reasoning = "Reasoning text. ![Not a reasoning image](http://127.0.0.1:1/never-load.png)";
  const fixture = await launchAutomationFixture("light", {
    port: await availableWebhookPort(),
    report,
    reasoning,
  });
  const { page } = fixture;
  try {
    await page.getByRole("button", { name: "New automation", exact: true }).click();
    await page.getByRole("textbox", { name: "Automation name" }).fill("Pull request review report");
    await page
      .getByRole("combobox", { name: "Project", exact: true })
      .selectOption(fixture.paths.project);
    await page.getByRole("button", { name: "GitHub webhook", exact: true }).click();
    await page.getByRole("textbox", { name: "Repository", exact: true }).fill("example/repo");
    await page
      .getByRole("textbox", { name: "Automation task" })
      .fill("Summarize the review in one sentence.");
    await page.getByRole("button", { name: "Create automation" }).click();
    await expect(page.getByRole("button", { name: "Enable webhook" })).toBeVisible();
    await page.getByRole("button", { name: "Generate secret" }).click();
    await expect(page.getByRole("button", { name: "Rotate secret" })).toBeVisible();
    await page.getByRole("button", { name: "Show", exact: true }).click();
    const secret = await page.getByLabel("New GitHub secret (shown here once)").inputValue();
    const endpoint = await page
      .getByRole("textbox", { name: "Local forwarding target" })
      .inputValue();
    await page.getByRole("button", { name: "Dismiss", exact: true }).click();
    await page.getByText("Preview a test delivery", { exact: true }).click();
    const body = JSON.stringify({
      action: "submitted",
      repository: { full_name: "example/repo" },
      pull_request: { number: 42, title: "Clarify retention policy" },
      review: { state: "approved", user: { login: "reviewer" }, body: "Approved. Thanks!" },
    });
    await page.getByRole("textbox", { name: "Test payload JSON" }).fill(body);
    await page.getByRole("button", { name: "Preview saved filter" }).click();
    await expect(page.getByText("Matches saved filter", { exact: false })).toBeVisible();
    await expect(page.locator("pre").filter({ hasText: '"pullRequest": 42' })).toBeVisible();
    await page.locator("pre").filter({ hasText: '"pullRequest": 42' }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath("github-webhook-preview.png") });
    await page.getByRole("button", { name: "Runs", exact: true }).click();
    await expect(page.getByText("No runs yet.", { exact: true })).toBeVisible();
    expect(fixture.modelRequests()).toBe(0);
    await page.getByRole("button", { name: "Enable webhook", exact: true }).click();
    await expect(page.getByRole("button", { name: "Pause webhook", exact: true })).toBeVisible();
    const response = await fetch(endpoint, {
      method: "POST",
      body,
      headers: {
        "Content-Type": "application/json",
        "X-GitHub-Event": "pull_request_review",
        "X-GitHub-Delivery": randomUUID(),
        "X-Hub-Signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
      },
    });
    expect(response.status).toBe(202);
    const openRun = page.getByRole("button", { name: "Open run", exact: true });
    await expect
      .poll(async () => {
        await page.getByRole("button", { name: "Refresh", exact: true }).click();
        return openRun.count();
      })
      .toBe(1);
    await openRun.click();
    await expect(page.getByText(report, { exact: true })).toBeVisible();
    await expect(page.getByRole("img", { name: "Not an active image" })).toHaveCount(0);
    const workLog = page.locator('[data-slot="activity-group"]');
    await workLog.getByText("Work log", { exact: true }).click();
    await workLog.getByRole("button", { name: "Reasoning", exact: true }).click();
    await expect(page.getByText(reasoning, { exact: true })).toBeVisible();
    await expect(page.getByRole("img", { name: "Not a reasoning image" })).toHaveCount(0);
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
    await openHistoryRun(page, "Evening review");
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
    await openHistoryRun(page, "Morning brief");
    const history = page.getByRole("group", { name: "Conversation history", exact: true });
    const back = history.getByRole("button", { name: "Go back in session history", exact: true });
    const forward = history.getByRole("button", {
      name: "Go forward in session history",
      exact: true,
    });
    // Visit history holds conversations, not the Automations page, so one step returns
    // to the previous run.
    await back.click();
    await expect(page.locator('[data-slot="workspace-header"]')).toContainText(
      "Review child replies",
    );
    await expect(forward).toBeEnabled();
    await forward.click();
    await expect(forward).toBeDisabled();
    await expect(page.locator('[data-slot="workspace-header"]')).toContainText("Morning brief");
    await page.getByRole("button", { name: "Automation", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Morning brief", exact: true })).toBeVisible();
  } finally {
    await fixture.close();
  }
});
