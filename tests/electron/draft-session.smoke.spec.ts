import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const repositoryRoot = resolve(import.meta.dirname, "../..");

test("restores, edits, resolves, and activates a project draft session", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "cake-draft-session-smoke-"));
  const userData = join(temporaryRoot, "user-data");
  const project = join(temporaryRoot, "project");
  const sessionId = "draft-session";
  await Promise.all([mkdir(userData, { recursive: true }), mkdir(project, { recursive: true })]);
  await writeFile(
    join(userData, "window-state.json"),
    JSON.stringify({
      projectPath: project,
      selectedSessionId: sessionId,
      activeConversation: { kind: "project-session", workspacePath: project, sessionId },
      recentProjectPaths: [project],
      draft: "",
      draftsBySession: {},
      pendingProjectSessions: [
        {
          sessionId,
          workspacePath: project,
          draft: "",
          name: "Planned work",
          draftSession: true,
          resolved: false,
          stagedPrompt: { text: "Original plan", attachments: [] },
        },
      ],
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
      resolvedCakeChatSessionIds: [],
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
    await expect(page.getByText("Original plan", { exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("Draft", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Resolve Planned work" }).click();
    await expect(page.getByRole("button", { name: "Restore Planned work" })).toBeVisible();
    await page.getByRole("button", { name: "Restore Planned work" }).click();

    await page.getByRole("button", { name: "Edit latest prompt" }).click();
    const composer = page.getByLabel("Message");
    await expect(composer).toBeFocused();
    await expect(composer).toHaveValue("Original plan");
    await composer.fill("Edited plan");
    await page.getByRole("button", { name: "Save draft" }).click();
    await expect(page.getByText("Edited plan", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Activate draft" }).click();
    await expect(page.getByText("Draft", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Edited plan", { exact: true })).toBeVisible();
  } finally {
    await application.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
