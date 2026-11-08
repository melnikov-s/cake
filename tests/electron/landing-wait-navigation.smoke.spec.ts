import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import { _electron as electron } from "../../scripts/queued-electron.mjs";
import { cakeWorkspaceSessionDirectory } from "../../src/services/pi/runtime/session-discovery";
import { windowState } from "../fixtures/window-state";
import { showSessions } from "./fixtures/workspace-navigation";

const exec = promisify(execFile);
const repositoryRoot = resolve(import.meta.dirname, "../..");

test("navigation remains interactive while a fixture landing waits behind a conflict owner", async () => {
  test.setTimeout(60_000);
  const root = await mkdtemp(join(tmpdir(), "cake-landing-wait-"));
  const project = join(root, "project");
  const userData = join(root, "user-data");
  const cakeHome = join(root, "cake-home");
  const ownerWorkspace = join(root, "owner");
  const waitingWorkspace = join(root, "waiter");
  const ownerSession = "landing-owner-fixture";
  const waitingSession = "landing-waiter-fixture";
  await Promise.all([
    mkdir(project),
    mkdir(userData),
    mkdir(join(cakeHome, "state"), { recursive: true }),
  ]);
  const git = (args: string[]) => exec("git", args, { cwd: project });
  await git(["init", "-b", "main"]);
  await git(["config", "user.name", "Fixture"]);
  await git(["config", "user.email", "fixture@example.test"]);
  await writeFile(join(project, "fixture.txt"), "fixture only\n");
  await git(["add", "."]);
  await git(["commit", "-m", "fixture"]);
  const head = (await git(["rev-parse", "HEAD"])).stdout.trim();
  const timestamp = "2026-01-01T00:00:00.000Z";
  const records = [];
  for (const [workspace, sessionId, branch] of [
    [ownerWorkspace, ownerSession, "owner"],
    [waitingWorkspace, waitingSession, "waiter"],
  ] as const) {
    await git(["worktree", "add", "-b", `agent/${branch}`, workspace]);
    records.push({
      projectPath: project,
      worktreePath: workspace,
      branch: `agent/${branch}`,
      baseBranch: "main",
      baseCommit: head,
      createdAt: timestamp,
      state: "active",
    });
    const sessions = cakeWorkspaceSessionDirectory(workspace, join(cakeHome, "pi", "sessions"));
    await mkdir(sessions, { recursive: true });
    await writeFile(
      join(sessions, `2026-01-01T00-00-00-000Z_${sessionId}.jsonl`),
      [
        { type: "session", version: 3, id: sessionId, cwd: workspace, timestamp },
        {
          type: "message",
          id: "user",
          parentId: null,
          timestamp,
          message: {
            role: "user",
            content: [{ type: "text", text: "Fixture conversation" }],
            timestamp: 0,
          },
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
    );
  }
  await writeFile(
    join(cakeHome, "state", "worktrees.json"),
    JSON.stringify({ schemaVersion: 1, records }),
  );
  await writeFile(
    join(cakeHome, "state", "application.json"),
    JSON.stringify({
      schemaVersion: 1,
      projects: [
        { path: project, name: "Landing fixture", addedAt: timestamp, lastOpenedAt: timestamp },
      ],
    }),
  );
  await writeFile(
    join(userData, "window-state.json"),
    windowState({
      project,
      workingDirectory: waitingWorkspace,
      sessionId: waitingSession,
      theme: "dark",
    }),
  );
  const app = await electron.launch({
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
    const page = await app.firstWindow();
    // Navigate explicitly: this smoke is not a test of legacy window-state restoration.
    await page
      .getByRole("button", { name: "Open Project Chat for Landing fixture", exact: true })
      .click();
    await showSessions(page);
    await page.locator(`.session-item[data-session-id="${waitingSession}"] .session-row`).click();
    const composer = page.getByRole("combobox", { name: "Message", exact: true });
    await expect(composer).toBeVisible({ timeout: 20_000 });
    const ids = await app.evaluate(
      async (_electron, input) => {
        const reserve = Reflect.get(globalThis, "cakeSmokeReserveLanding") as (
          value: typeof input,
        ) => Promise<{ owner: string; waiter: string }>;
        return reserve(input);
      },
      { ownerWorkspace, waitingWorkspace, ownerSession, waitingSession },
    );
    const queued = page.getByText(`Queued #1 behind landing ${ids.owner.slice(0, 8)}`, {
      exact: false,
    });
    await expect(queued).toContainText("waiting for conflict resolution");
    await expect(page.getByRole("button", { name: "Cancel queued merge" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Merging…", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Back to chat", exact: true }).click();
    await expect(queued).toContainText("waiting for conflict resolution");
    await composer.fill("Navigation still works while queued");
    await expect(composer).toHaveValue("Navigation still works while queued");
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
    // No landing, resolve, provider request or user checkout is involved in this fixture.
    expect((await git(["rev-parse", "HEAD"])).stdout.trim()).toBe(head);
    expect(await readFile(join(project, "fixture.txt"), "utf8")).toBe("fixture only\n");
    await app.evaluate(() =>
      (Reflect.get(globalThis, "cakeSmokeClearLanding") as () => Promise<void>)(),
    );
    await expect(queued).toHaveCount(0);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
