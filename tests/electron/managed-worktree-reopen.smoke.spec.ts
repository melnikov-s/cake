import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "../../scripts/queued-electron.mjs";
import { expect, test } from "@playwright/test";
import { defaultApplicationState } from "../../src/contracts/application/application-data";
import { cakeWorkspaceSessionDirectory } from "../../src/services/pi/runtime/session-discovery";
import { windowState } from "../fixtures/window-state";

const repositoryRoot = resolve(import.meta.dirname, "../..");

for (const state of ["active", "resolved"] as const) {
  test(`reopens ${state} managed-worktree history without an approval prompt`, async () => {
    const root = await mkdtemp(join(tmpdir(), "cake-reopen-worktree-"));
    const userData = join(root, "user-data");
    const cakeHome = join(root, "cake-home");
    const project = join(root, "project");
    const workingDirectory = join(root, "retired-worktree");
    const sessionId = "reopen-session";
    const activeRoot = join(cakeHome, "pi", "sessions");
    const sessionDirectory = cakeWorkspaceSessionDirectory(workingDirectory, activeRoot);
    const timestamp = new Date(0).toISOString();
    await Promise.all(
      [userData, project, sessionDirectory, join(cakeHome, "state", "resolved-project-metadata")]
        .concat(state === "active" ? [workingDirectory] : [])
        .map((path) => mkdir(path, { recursive: true })),
    );
    const applicationPath = join(cakeHome, "state", "application.json");
    const worktreesPath = join(cakeHome, "state", "worktrees.json");
    const resolutionPath = join(cakeHome, "state", "resolved-project-metadata", "resolution.json");
    await writeFile(
      applicationPath,
      JSON.stringify({
        version: 7,
        data: {
          ...defaultApplicationState(),
          projects: [
            { path: project, name: "project", addedAt: timestamp, lastOpenedAt: timestamp },
          ],
        },
      }),
    );
    await writeFile(
      worktreesPath,
      JSON.stringify({
        schemaVersion: 1,
        records: [
          {
            projectPath: project,
            worktreePath: workingDirectory,
            branch: "agent/reopen",
            baseBranch: "main",
            state,
            ...(state === "resolved" ? { resolvedFrom: "landed" } : {}),
            createdAt: timestamp,
          },
        ],
      }),
    );
    await writeFile(
      resolutionPath,
      JSON.stringify({
        version: 1,
        directories: { [sessionDirectory]: state === "resolved" ? [sessionId] : [] },
      }),
    );
    await writeFile(
      join(sessionDirectory, `1970-01-01T00-00-00-000Z_${sessionId}.jsonl`),
      [
        { type: "session", version: 3, id: sessionId, timestamp, cwd: workingDirectory },
        {
          type: "message",
          id: "user",
          parentId: null,
          timestamp,
          message: {
            role: "user",
            content: [{ type: "text", text: "Retained conversation content" }],
            timestamp: 0,
          },
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
    );
    await writeFile(
      join(userData, "window-state.json"),
      windowState({ project: workingDirectory, sessionId }),
    );
    const launch = () =>
      electron.launch({
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
      // Exercise persisted-window restoration twice, not just warm sidebar navigation.
      for (let attempt = 0; attempt < 2; attempt++) {
        const application = await launch();
        try {
          const page = await application.firstWindow();
          await expect(
            page
              .locator('[data-slot="session-pane"]')
              .getByText("Retained conversation content", { exact: true })
              .first(),
          ).toBeVisible({ timeout: 20_000 });
          await expect(page.getByRole("alertdialog")).toHaveCount(0);
          expect(
            await application.evaluate(({ BrowserWindow }) =>
              BrowserWindow.getAllWindows().every(
                (window) => !window.isVisible() && !window.isFocused(),
              ),
            ),
          ).toBe(true);
        } finally {
          await application.close();
        }
        expect(JSON.parse(await readFile(worktreesPath, "utf8")).records[0].state).toBe(state);
        if (state === "resolved") {
          await expect(access(workingDirectory)).rejects.toThrow();
          expect(
            JSON.parse(await readFile(resolutionPath, "utf8")).directories[sessionDirectory],
          ).toEqual([sessionId]);
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
