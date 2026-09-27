import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { _electron as electron, chromium, expect, test, type Page } from "@playwright/test";
import { cakeWorkspaceSessionDirectory } from "../../src/services/pi/runtime/session-discovery";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const openSharing = async (page: Page) => {
  await page.getByRole("button", { name: "Open settings", exact: true }).click();
  await page.getByRole("button", { name: "Network & privacy", exact: true }).click();
  await expect(page.getByRole("switch", { name: "Enable browser sharing" })).toBeEnabled();
};

test("desktop Settings shares the existing backend; window closure, reopen, disable and quit preserve ownership", async () => {
  test.setTimeout(60_000);
  const directory = await mkdtemp(join(tmpdir(), "cake-desktop-sharing-"));
  const userData = join(directory, "user-data");
  const home = join(directory, "cake-home");
  const project = join(directory, "project");
  const sessions = cakeWorkspaceSessionDirectory(project, join(home, "pi", "sessions"));
  const id = "00000000-0000-4000-8000-000000000001";
  const timestamp = new Date(0).toISOString();
  const title = "Existing desktop transcript";
  await Promise.all(
    [userData, project, sessions, join(home, "state")].map((path) =>
      mkdir(path, { recursive: true }),
    ),
  );
  await writeFile(
    join(home, "state", "application.json"),
    JSON.stringify({
      schemaVersion: 1,
      projects: [
        { path: project, name: "Sharing project", addedAt: timestamp, lastOpenedAt: timestamp },
      ],
      trustedProjectPaths: [project],
    }),
  );
  await writeFile(
    join(userData, "window-state.json"),
    JSON.stringify({
      projectPath: project,
      selectedSessionId: id,
      activeConversation: { kind: "project-session", workspacePath: project, sessionId: id },
      recentProjectPaths: [project],
      draft: "",
    }),
  );
  await writeFile(
    join(sessions, ".pi-session-metadata.json"),
    JSON.stringify({ version: 1, sessions: { [id]: { title } } }),
  );
  await writeFile(
    join(sessions, `1970-01-01T00-00-00-000Z_${id}.jsonl`),
    [
      { type: "session", version: 3, id, timestamp, cwd: project },
      {
        type: "message",
        id: "user-entry",
        parentId: null,
        timestamp,
        message: { role: "user", content: [{ type: "text", text: title }], timestamp: 0 },
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n") + "\n",
  );
  const application = await electron.launch({
    args: [repositoryRoot],
    cwd: repositoryRoot,
    env: {
      ...process.env,
      CAKE_ELECTRON_SMOKE: "1",
      CAKE_ELECTRON_USER_DATA: userData,
      CAKE_HOME: home,
    },
  });
  const childProcess = application.process();
  const browser = await chromium.launch({ channel: "chromium-headless-shell" });
  try {
    const local = await application.firstWindow();
    local.setDefaultTimeout(15_000);
    await expect(local.locator(".transcript").getByText(title, { exact: true })).toBeVisible({
      timeout: 20_000,
    });
    await openSharing(local);
    const toggle = local.getByRole("switch", { name: "Enable browser sharing" });
    await expect(toggle).not.toBeChecked();
    // A real listener failure remains actionable in Settings and never enables sharing.
    const occupied = createServer();
    await new Promise<void>((resolve) => occupied.listen(0, "127.0.0.1", resolve));
    try {
      const address = occupied.address();
      if (!address || typeof address === "string") throw new Error("Missing occupied port");
      await local.getByLabel("Browser sharing port", { exact: true }).fill(String(address.port));
      await toggle.click();
      await expect(local.locator("#setting-browser-sharing")).toContainText("EADDRINUSE");
      await expect(toggle).not.toBeChecked();
      await expect(toggle).toBeEnabled();
    } finally {
      await new Promise<void>((resolve, reject) =>
        occupied.close((error) => (error ? reject(error) : resolve())),
      );
    }
    await local.getByLabel("Browser sharing port", { exact: true }).fill("0");
    await toggle.click();
    await expect(toggle).toBeChecked();
    const status = local.locator("#setting-browser-sharing").getByRole("status");
    await expect(status).toContainText("http://127.0.0.1:");
    const url = /http:\/\/127\.0\.0\.1:\d+\//.exec(await status.innerText())?.[0];
    expect(url).toBeTruthy();
    if (!url) throw new Error("Missing bound browser address");
    const remote = await browser.newPage();
    remote.setDefaultTimeout(15_000);
    await remote.goto(url);
    await expect(remote.getByText("Connected", { exact: true })).toBeVisible();
    await remote.getByLabel("Project", { exact: true }).selectOption(project);
    await remote.getByLabel("Session", { exact: true }).selectOption(id);
    await expect(remote.getByText(title, { exact: true }).last()).toBeVisible();
    const message = remote.getByLabel("Message Cake", { exact: true });
    await message.click();
    await message.pressSequentially("browser-only draft");
    await expect(message).toBeFocused();
    await expect(message).toHaveValue("browser-only draft");

    // Allocate a second real desktop client AFTER the socket. Logical IDs now differ from
    // native WebContents IDs; verify native menu delivery and survivor cleanup, not just RPC.
    await application.evaluate(({ Menu }) => {
      const item = Menu.getApplicationMenu()
        ?.items.flatMap((entry) => entry.submenu?.items ?? [])
        .find((entry) => entry.label === "New Cake Window");
      if (!item) throw new Error("New Cake Window menu item missing");
      item.click({}, undefined);
    });
    await expect.poll(() => application.windows().length).toBe(2);
    const second = application.windows().find((window) => window !== local);
    if (!second) throw new Error("Second desktop window missing");
    await second.getByRole("button", { name: "Network & privacy", exact: true }).click();
    await expect(second.getByRole("switch", { name: "Enable browser sharing" })).toBeChecked();
    await second.getByRole("button", { name: "Back to chat", exact: true }).click();
    await second.locator(`.session-item[data-session-id="${id}"] .session-row`).click();
    await expect(second.locator(".transcript").getByText(title, { exact: true })).toBeVisible();
    await application.evaluate(({ Menu }) => {
      const item = Menu.getApplicationMenu()
        ?.items.flatMap((entry) => entry.submenu?.items ?? [])
        .find((entry) => entry.label === "Toggle Terminal");
      if (!item) throw new Error("Toggle Terminal menu item missing");
      item.click({}, undefined);
    });
    await expect(second.locator('section[aria-label="Terminal"]')).toHaveAttribute(
      "aria-hidden",
      "false",
    );
    await expect(local.locator('section[aria-label="Terminal"]')).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    await openSharing(second);
    const secondWindow = await application.browserWindow(second);
    await secondWindow.evaluate((window) => window.close());
    await expect.poll(() => application.windows().length).toBe(1);
    // The remaining native client's requests and the browser connection still work.
    await toggle.click();
    await expect(toggle).not.toBeChecked();
    await expect(remote.getByText("Disconnected · reconnecting…", { exact: true })).toBeVisible();
    await toggle.click();
    await expect(toggle).toBeChecked();
    await expect(remote.getByText("Connected", { exact: true })).toBeVisible();

    await application.evaluate(({ BrowserWindow }) => {
      for (const window of BrowserWindow.getAllWindows()) window.close();
    });
    await expect.poll(() => application.windows().length).toBe(0);
    await expect(remote.getByText("Connected", { exact: true })).toBeVisible();
    expect((await remote.request.get(url)).status()).toBe(200);
    await application.evaluate(({ app }) => app.emit("activate"));
    await expect.poll(() => application.windows().length).toBe(1);
    const reopened = application.windows()[0];
    if (!reopened) throw new Error("Window did not reopen");
    reopened.setDefaultTimeout(15_000);
    // Window snapshot restores the Settings surface; only the active settings page resets.
    await reopened.getByRole("button", { name: "Network & privacy", exact: true }).click();
    const reopenedToggle = reopened.getByRole("switch", { name: "Enable browser sharing" });
    await expect(reopenedToggle).toBeChecked();
    await expect(reopened.locator("#setting-browser-sharing").getByRole("status")).toContainText(
      url,
    );
    await reopenedToggle.click();
    await expect(reopenedToggle).not.toBeChecked();
    await expect(remote.getByText("Disconnected · reconnecting…", { exact: true })).toBeVisible();
    await expect(message).toHaveValue("browser-only draft");
    await reopenedToggle.click();
    await expect(reopenedToggle).toBeChecked();
    await expect(remote.getByText("Connected", { exact: true })).toBeVisible();
    await expect(remote.getByText(title, { exact: true }).last()).toBeVisible();
    await expect(message).toHaveValue("browser-only draft");
    await application.close();
    await expect(remote.getByText("Disconnected · reconnecting…", { exact: true })).toBeVisible();
    expect(childProcess.exitCode).toBe(0);
  } finally {
    await browser.close();
    if (childProcess.exitCode === null) await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});
