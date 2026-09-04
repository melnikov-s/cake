import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { _electron as electron, expect, test } from "@playwright/test";
import { cakeWorkspaceSessionDirectory } from "../../src/services/pi/runtime/session-discovery";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const execFileAsync = promisify(execFile);

async function seedGitRepository(project: string) {
  const git = async (...args: string[]) => execFileAsync("git", args, { cwd: project });
  await git("init", "-b", "main");
  await git("config", "user.email", "cake@example.test");
  await git("config", "user.name", "Cake Test");
  await writeFile(join(project, "README.md"), "base\n");
  await git("add", "-A");
  await git("commit", "-m", "base");
}

test("forks and hands off sessions across working directories", async () => {
  test.setTimeout(120_000);
  const temporaryRoot = await mkdtemp(join(tmpdir(), "cake-fork-dialog-smoke-"));
  const userData = join(temporaryRoot, "user-data");
  const project = join(temporaryRoot, "project");
  const cakeHome = join(temporaryRoot, "cake-home");
  const sessionId = "fork-dialog-session";
  const timestamp = new Date(0).toISOString();
  const sessionDirectory = cakeWorkspaceSessionDirectory(project, join(cakeHome, "pi", "sessions"));
  await Promise.all([
    mkdir(userData, { recursive: true }),
    mkdir(project, { recursive: true }),
    mkdir(sessionDirectory, { recursive: true }),
  ]);
  await seedGitRepository(project);
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
  await mkdir(join(cakeHome, "state"), { recursive: true });
  await writeFile(
    join(cakeHome, "state", "application.json"),
    JSON.stringify({
      schemaVersion: 1,
      projects: [
        {
          path: project,
          name: "project",
          addedAt: timestamp,
          lastOpenedAt: timestamp,
        },
      ],
      trustedProjectPaths: [],
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
          content: [{ type: "text", text: "Plan the focused fix" }],
          timestamp: 0,
        },
      },
      {
        type: "message",
        id: "assistant-1",
        parentId: "user-1",
        timestamp,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Here is the plan." }],
          api: "anthropic-messages",
          provider: "anthropic",
          model: "fixture",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp: 1,
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
    const fork = page.getByRole("button", {
      name: "Fork response with full context into new chat",
    });
    await expect(fork).toBeVisible({ timeout: 20_000 });
    await fork.click({ force: true });

    const dialog = page.getByRole("dialog", { name: "Fork this conversation" });
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByRole("button", { name: "Use the current working directory" }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(
      dialog.getByRole("button", { name: "Branch off the current worktree" }),
    ).toBeDisabled();
    await expect(
      dialog.getByRole("button", { name: "Use the project root (no worktree)" }),
    ).toBeVisible();
    await expect(dialog.getByLabel("Worktree name")).toHaveCount(0);
    await expect(
      dialog.getByRole("switch", { name: "Resolve the parent conversation after forking" }),
    ).not.toBeChecked();

    await dialog.getByRole("button", { name: "Create a new worktree" }).click();
    const name = dialog.getByLabel("Worktree name");
    await expect(name).toBeVisible();
    await expect(name).toBeFocused();
    await expect(name).toHaveValue(/^plan-the-focused-fix-[a-f0-9]{6}$/);
    await name.fill("focused-fix");
    await expect(name).toHaveValue("focused-fix");
    await dialog
      .getByRole("switch", { name: "Resolve the parent conversation after forking" })
      .click();

    await dialog.getByRole("button", { name: "Fork conversation" }).click();
    await expect(dialog).toHaveCount(0);
    // The forked conversation opens in its new worktree (the worktree pill shows its
    // branch) instead of failing with "Cake could not find that session". The forked
    // transcript carries the parent's content.
    await expect(page.getByText("focused-fix").first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("Here is the plan.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Start new chat in project" })).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Start new chat in focused-fix" })).toHaveCount(
      0,
    );

    // Preview hydration happens before the workspace runtime finishes opening. Wait
    // until the composer can submit so a late session-open failure cannot race this check.
    const composer = page.getByRole("combobox", { name: "Message" });
    await expect(composer).toBeVisible();
    await composer.fill("Continue in the fork");
    await expect(composer).toBeFocused();
    await expect(composer).toHaveValue("Continue in the fork");
    await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();
    await expect(page.getByText("Cake could not find that session")).toHaveCount(0);

    // Hand the worktree fork back to the project root. The handoff dialog offers
    // both a child branch and a checkout-free destination, and writes the abridged
    // transcript into the selected Working Directory.
    await page
      .getByRole("button", { name: "Hand off response without tool history into new chat" })
      .click({ force: true });
    const rootHandoffDialog = page.getByRole("dialog", { name: "Hand off this conversation" });
    await expect(
      rootHandoffDialog.getByRole("button", { name: "Branch off the current worktree" }),
    ).toBeEnabled();
    await rootHandoffDialog
      .getByRole("button", { name: "Use the project root (no worktree)" })
      .click();
    await rootHandoffDialog.getByRole("button", { name: "Hand off conversation" }).click();
    await expect(page.getByText("Here is the plan.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Start new chat in project" })).toHaveCount(1);
    await expect(page.getByText("Cake could not find that session")).toHaveCount(0);

    // Continue from the now-resolved parent. Handoff should create and open an
    // active copy without restoring the parent in the sidebar.
    await page.getByRole("button", { name: "Expand Resolved" }).click();
    await page.getByRole("button", { name: "Expand project resolved" }).last().click();
    const resolvedParent = page.locator(
      `[data-slot="resolved-lane"] [data-session-id="${sessionId}"]`,
    );
    await expect(resolvedParent).toBeVisible();
    await resolvedParent.locator(".session-row").click();
    const handoff = page.getByRole("button", {
      name: "Hand off response without tool history into new chat",
    });
    await expect(handoff).toBeVisible();
    await handoff.click({ force: true });
    const handoffDialog = page.getByRole("dialog", { name: "Hand off this conversation" });
    await expect(handoffDialog).toBeVisible();
    await expect(
      handoffDialog.getByRole("button", { name: "Use the current working directory" }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(
      handoffDialog.getByRole("switch", {
        name: "Resolve the parent conversation after handoff",
      }),
    ).not.toBeChecked();
    await handoffDialog.getByRole("button", { name: "Hand off conversation" }).click();

    await expect(page.getByText("Here is the plan.")).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Message" })).toBeVisible();
    await expect(page.getByText("Cake could not find that session")).toHaveCount(0);
    await expect(resolvedParent).toBeVisible();
  } finally {
    await application.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
