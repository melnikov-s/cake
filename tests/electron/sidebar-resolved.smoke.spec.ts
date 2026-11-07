import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "../../scripts/queued-electron.mjs";
import { expect, test } from "@playwright/test";
import { cakeWorkspaceSessionDirectory } from "../../src/services/pi/runtime/session-discovery";
import { windowState } from "../fixtures/window-state";
import { showSessions } from "./fixtures/workspace-navigation";

const repositoryRoot = resolve(import.meta.dirname, "../..");

test("resolves and restores the selected session through the project Sessions accessory", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "cake-sidebar-resolved-smoke-"));
  const userData = join(temporaryRoot, "user-data");
  const project = join(temporaryRoot, "project");
  const cakeHome = join(temporaryRoot, "cake-home");
  const sessionId = "sidebar-resolved-session";
  const projectChatId = `project-chat:${createHash("sha256").update(project).digest("hex")}`;
  const sessionDirectory = cakeWorkspaceSessionDirectory(project, join(cakeHome, "pi", "sessions"));
  const timestamp = new Date(0).toISOString();
  await Promise.all([
    mkdir(userData, { recursive: true }),
    mkdir(project, { recursive: true }),
    mkdir(sessionDirectory, { recursive: true }),
  ]);
  await writeFile(
    join(userData, "window-state.json"),
    windowState({ project, sessionId, theme: "system" }),
  );
  await mkdir(join(cakeHome, "state"), { recursive: true });
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
    }),
  );
  await writeFile(
    join(sessionDirectory, `1970-01-01T00-00-00-000Z_${sessionId}.jsonl`),
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
      PI_CODING_AGENT_DIR: join(cakeHome, "pi"),
      PI_CODING_AGENT_SESSION_DIR: "",
    },
  });

  try {
    const page = await application.firstWindow();
    await expect(page.getByRole("button", { name: "Search sessions" })).toBeVisible({
      timeout: 20_000,
    });
    // Explicit selection keeps this regression independent of startup selection policy.
    await page.getByRole("button", { name: "Search sessions" }).click();
    const search = page.getByRole("dialog", { name: "Search sessions" });
    await search.getByRole("combobox").fill("Implement the resolved sidebar");
    await search.getByRole("option", { name: /Implement the resolved sidebar/ }).click();
    await expect(page.getByRole("combobox", { name: "Message", exact: true })).toBeVisible();
    const workspace = await showSessions(page);

    const selectedSession = page
      .locator(".session-item.active")
      .filter({ has: page.locator(".session-resolve-action") });
    await expect(selectedSession).toHaveCount(1);
    await expect(selectedSession.locator(".session-time")).toHaveCount(1);
    await expect(selectedSession.locator('[data-slot="avatar"]')).toHaveAttribute(
      "data-variant",
      "square",
    );
    await expect(page.getByRole("button", { name: "Ask session assistant" })).toBeVisible();
    await selectedSession.locator(".session-resolve-action").click();
    await expect(
      page
        .getByRole("navigation", { name: "Conversation breadcrumb" })
        .getByRole("button", { name: "project", exact: true }),
    ).toHaveAttribute("aria-current", "page");
    await expect(page.locator('[data-slot="session-pane"]')).toHaveAttribute(
      "data-session-id",
      projectChatId,
    );
    await expect(
      page.getByRole("button", { name: "Open Cake Chat", exact: true }),
    ).not.toHaveAttribute("aria-current", "page");
    await expect(
      page.getByRole("combobox", { name: "Message Project Chat", exact: true }),
    ).toBeVisible();
    await expect(page.getByTestId("resolved-session-notice")).toHaveCount(0);

    await page
      .getByRole("navigation", { name: "Projects and global utilities" })
      .getByRole("button", { name: "Open Project Chat for project", exact: true })
      .click();
    await showSessions(page);
    const resolvedToggle = workspace.getByRole("button", {
      name: "Resolved sessions",
      exact: true,
    });
    await expect(resolvedToggle).toHaveAttribute("aria-expanded", "false");
    await resolvedToggle.click();
    const resolvedLane = workspace.getByRole("region", { name: "Resolved sessions" });
    const resolvedSession = resolvedLane.locator(`.session-item[data-session-id="${sessionId}"]`);
    await expect(resolvedSession.getByRole("img", { name: "Resolved session" })).toBeVisible();
    await resolvedSession.locator(".session-row").click();
    await expect(page.getByRole("button", { name: "Ask session assistant" })).toHaveCount(0);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect(page.getByTestId("resolved-session-notice")).toContainText(
      "Send a message to restore this session",
    );
    await expect(page.getByRole("button", { name: "Open VS Code" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^Terminal/ })).toHaveCount(0);

    const restoreAction = resolvedSession.getByRole("button", { name: /^Restore / });
    await expect(restoreAction).toBeVisible();
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await restoreAction.click();
    await expect(restoreAction).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Ask session assistant" })).toBeVisible();
    await expect(selectedSession.locator('[data-slot="avatar"]')).toHaveAttribute(
      "data-variant",
      "square",
    );
    await expect(workspace.locator(`.session-item[data-session-id="${sessionId}"]`)).toHaveCount(1);
    await expect(page.getByRole("combobox", { name: "Message", exact: true })).toBeVisible();
  } finally {
    await application.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
