import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { cakeWorkspaceSessionDirectory } from "../../src/agent/session-discovery";

const repositoryRoot = resolve(import.meta.dirname, "../..");

test("resolves and restores the selected project session in the desktop sidebar", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "cake-sidebar-resolved-smoke-"));
  const userData = join(temporaryRoot, "user-data");
  const project = join(temporaryRoot, "project");
  const cakeHome = join(temporaryRoot, "cake-home");
  const sessionId = "sidebar-resolved-session";
  const sessionDirectory = cakeWorkspaceSessionDirectory(project, join(cakeHome, "pi", "sessions"));
  const timestamp = new Date(0).toISOString();
  await Promise.all([
    mkdir(userData, { recursive: true }),
    mkdir(project, { recursive: true }),
    mkdir(sessionDirectory, { recursive: true }),
  ]);
  await writeFile(
    join(userData, "window-state.json"),
    JSON.stringify({
      projectPath: project,
      selectedSessionId: sessionId,
      activeConversation: { kind: "project-session", workspacePath: project, sessionId },
      recentProjectPaths: [project],
      draft: "",
      theme: "system",
      draftsBySession: {},
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
      resolvedCakeChatSessionIds: [],
      trustedProjectPaths: [],
    }),
  );
  await writeFile(
    join(sessionDirectory, `${sessionId}.jsonl`),
    [
      { type: "session", version: 3, id: sessionId, timestamp, cwd: project },
      {
        type: "message",
        id: "user-1",
        parentId: null,
        timestamp,
        message: {
          role: "user",
          content: [{ type: "text", text: "Implement the resolved sidebar" }],
          timestamp: 0,
        },
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
      CAKE_HOME: cakeHome,
    },
  });

  try {
    const page = await application.firstWindow();
    await expect(page.getByLabel("Message")).toBeVisible({ timeout: 20_000 });
    const cakeChatGroup = page.locator(".sidebar-scroll > .cake-chat-sessions");
    await expect(cakeChatGroup.locator(".project-label")).toHaveText("Cake Chat");
    await expect(cakeChatGroup.locator(".project-label svg")).toHaveAttribute("width", "16");
    await expect(page.locator(".resolved-lane")).toHaveCount(0);

    const selectedSession = page
      .locator(".session-item.active")
      .filter({ has: page.locator(".session-resolve-action") });
    await expect(selectedSession).toHaveCount(1);
    await expect(selectedSession.locator(".session-time")).toHaveCount(1);
    await selectedSession.locator(".session-resolve-action").click();

    await expect(page.locator(".resolved-lane")).toBeVisible();
    await expect(
      page.locator(".resolved-lane .session-item.active .session-resolve-action"),
    ).toHaveAttribute("aria-label", /^Restore /);
    const resolvedToggle = page.getByRole("button", { name: "Collapse Resolved" });
    await expect(resolvedToggle).toHaveAttribute("aria-expanded", "true");
    await resolvedToggle.click();
    await expect(page.getByRole("button", { name: "Expand Resolved" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    await expect(page.locator("#resolved-lane-content")).toHaveCount(0);
    await page.getByRole("button", { name: "Expand Resolved" }).click();
    await page.locator(".resolved-lane .session-item.active .session-resolve-action").click();
    await expect(page.locator(".resolved-lane")).toHaveCount(0);
  } finally {
    await application.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
