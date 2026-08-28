import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { cakeWorkspaceSessionDirectory } from "../../src/agent/session-discovery";

const repositoryRoot = resolve(import.meta.dirname, "../..");

const sessionEntries = (sessionId: string, project: string, timestamp: string, text: string) => [
  { type: "session", version: 3, id: sessionId, timestamp, cwd: project },
  {
    type: "message",
    id: `${sessionId}-user-1`,
    parentId: null,
    timestamp,
    message: { role: "user", content: [{ type: "text", text }], timestamp: 0 },
  },
];

test("navigates session history with back, forward, and resolve", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "cake-session-history-smoke-"));
  const userData = join(temporaryRoot, "user-data");
  const project = join(temporaryRoot, "project");
  const cakeHome = join(temporaryRoot, "cake-home");
  const backSessionId = "history-back-session";
  const forwardSessionId = "history-forward-session";
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
      selectedSessionId: forwardSessionId,
      activeConversation: {
        kind: "project-session",
        workspacePath: project,
        sessionId: forwardSessionId,
      },
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
  await Promise.all([
    writeFile(
      join(sessionDirectory, `${backSessionId}.jsonl`),
      `${sessionEntries(backSessionId, project, timestamp, "First history session")
        .map((entry) => JSON.stringify(entry))
        .join("\n")}\n`,
    ),
    writeFile(
      join(sessionDirectory, `${forwardSessionId}.jsonl`),
      `${sessionEntries(forwardSessionId, project, timestamp, "Second history session")
        .map((entry) => JSON.stringify(entry))
        .join("\n")}\n`,
    ),
  ]);

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

    const back = page.getByRole("button", { name: "Go back in session history" });
    const forward = page.getByRole("button", { name: "Go forward in session history" });
    const activeBackSession = page.locator(
      ".session-item.active[data-session-id='history-back-session']",
    );
    const activeForwardSession = page.locator(
      ".session-item.active[data-session-id='history-forward-session']",
    );
    const backShortcut = process.platform === "darwin" ? "Meta+[" : "Alt+ArrowLeft";
    const forwardShortcut = process.platform === "darwin" ? "Meta+]" : "Alt+ArrowRight";

    await expect(back).toBeDisabled();
    await expect(forward).toBeDisabled();

    await page.locator(".session-row").filter({ hasText: "First history session" }).click();
    await expect(activeBackSession).toHaveCount(1);
    await expect(back).toBeEnabled();

    await page.locator(".session-row").filter({ hasText: "Second history session" }).click();
    await expect(activeForwardSession).toHaveCount(1);
    await expect(back).toBeEnabled();
    await expect(forward).toBeDisabled();

    await page.keyboard.press(backShortcut);
    await expect(activeBackSession).toHaveCount(1);
    await expect(forward).toBeEnabled();

    await forward.click();
    await expect(activeForwardSession).toHaveCount(1);

    await page.keyboard.press(backShortcut);
    await expect(activeBackSession).toHaveCount(1);

    await page.keyboard.press(forwardShortcut);
    await expect(activeForwardSession).toHaveCount(1);

    await activeForwardSession.locator(".session-resolve-action").click();
    await expect(activeBackSession).toHaveCount(1);
    await expect(back).toBeDisabled();
    await expect(page.locator(".resolved-lane")).toBeVisible();
    await expect(
      page.locator(
        ".resolved-lane .session-item.active[data-session-id='history-forward-session']",
      ),
    ).toHaveCount(0);
  } finally {
    await application.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
