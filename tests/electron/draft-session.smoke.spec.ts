import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const repositoryRoot = resolve(import.meta.dirname, "../..");

test("restores, edits, resolves, and activates a project draft session", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "cake-draft-session-smoke-"));
  const userData = join(temporaryRoot, "user-data");
  const project = join(temporaryRoot, "project");
  const cakeHome = join(temporaryRoot, "cake-home");
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
          lifecycle: "saved-draft",
          resolved: false,
          stagedPrompt: { text: "Original plan", attachments: [] },
        },
      ],
      theme: "system",
    }),
  );
  await mkdir(join(cakeHome, "state"), { recursive: true });
  const applicationDocument = join(cakeHome, "state", "application.json");
  await writeFile(
    applicationDocument,
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
    },
  });

  try {
    const page = await application.firstWindow();
    await expect(page.getByText("Original plan", { exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("Draft", { exact: true })).toBeVisible();
    const draftSidebarItem = page.locator(`[data-session-id="${sessionId}"]`);
    await expect(draftSidebarItem.getByText("main", { exact: true })).toHaveCount(0);
    await expect(page.getByLabel("Message")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Current checkout" })).toBeVisible();
    await expect(page.getByRole("button", { name: "New worktree" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Draft", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Activate draft" })).toBeVisible();
    const draftStatus = page.locator('[data-slot="composer-leading-accessory"]');
    const draftStatusPicker = draftStatus.getByRole("button", {
      name: "Change session status. Current status: Unlabelled",
    });
    await expect(draftStatusPicker).toBeVisible();
    await draftStatusPicker.click();
    await page.getByRole("radio", { name: "Feature" }).click();
    await expect(
      draftStatus.getByRole("button", {
        name: "Change session status. Current status: Feature",
      }),
    ).toBeVisible();
    const draftToolbar = page.locator('[data-slot="composer-toolbar"]');
    await expect(draftToolbar).toHaveCSS("border-top-width", "0px");

    const panes = page.locator('[data-slot="session-pane"]');
    await panes.nth(0).getByRole("button", { name: "Split right" }).click();
    await expect(panes).toHaveCount(2);
    await panes.nth(0).getByRole("button", { name: "Close pane" }).click();
    await expect(panes).toHaveCount(1);
    await expect(draftSidebarItem).toBeVisible();
    await draftSidebarItem.click();
    await expect(page.getByText("Original plan", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Activate draft" })).toBeVisible();

    await page.getByRole("button", { name: "Resolve Planned work" }).click();
    await page.getByRole("button", { name: "Expand Resolved" }).click();
    await page.getByRole("button", { name: "Expand project resolved" }).last().click();
    await expect(page.getByRole("button", { name: "Restore Planned work" })).toBeVisible();
    await page.getByRole("button", { name: "Restore Planned work" }).click();

    await page.getByText("Original plan", { exact: true }).hover();
    await page.getByRole("button", { name: "Edit latest prompt" }).click();
    const composer = page.getByLabel("Message");
    await expect(composer).toBeFocused();
    await expect(composer).toHaveValue("Original plan");
    await expect(page.getByRole("button", { name: "Draft", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    await page.getByRole("button", { name: "Open settings", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Back to chat" }).click();
    await expect(page.getByLabel("Message")).toHaveCount(0);
    await expect(page.getByText("Original plan", { exact: true })).toBeVisible();

    await page.getByText("Original plan", { exact: true }).hover();
    await page.getByRole("button", { name: "Edit latest prompt" }).click();
    await expect(composer).toBeFocused();
    await expect(composer).toHaveValue("Original plan");
    await composer.fill("Edited plan");
    await page.getByRole("button", { name: "Save draft" }).click();
    await expect(page.getByText("Edited plan", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Message")).toHaveCount(0);

    await page.getByRole("button", { name: "Current checkout" }).click();
    await page.getByRole("button", { name: "Activate draft" }).click();
    await expect(page.getByText("Draft", { exact: true })).toHaveCount(0);
    await expect(
      page.locator('[data-slot="message-content"]', { hasText: "Edited plan" }),
    ).toBeVisible();
    // The session avatar and status picker persist beside the composer after activation.
    await expect(draftStatus).toHaveCSS("opacity", "1");
    await expect(draftStatus).not.toHaveAttribute("inert");
    await expect(draftStatus).toHaveAttribute("aria-hidden", "false");
    await expect(
      draftStatus.getByRole("button", {
        name: "Change session status. Current status: Feature",
      }),
    ).toBeEnabled();
    await expect
      .poll(async () => {
        const stored = JSON.parse(await readFile(applicationDocument, "utf8"));
        const state = stored.data ?? stored;
        const workflow = state.projects[0].workflow;
        const feature = state.globalWorkflowStatuses.find(
          (status: { name: string }) => status.name === "Feature",
        );
        return workflow.assignments.some(
          (assignment: { sessionId: string; statusId: string }) =>
            assignment.sessionId === sessionId && assignment.statusId === feature?.id,
        );
      })
      .toBe(true);
  } finally {
    await application.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
