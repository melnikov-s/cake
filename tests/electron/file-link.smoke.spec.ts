import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { cakeWorkspaceSessionDirectory } from "../../src/agent/session-discovery";

const repositoryRoot = resolve(import.meta.dirname, "../..");

test("a file-path link in an assistant message opens the file in Browse", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "cake-file-link-smoke-"));
  const userData = join(temporaryRoot, "user-data");
  const project = join(temporaryRoot, "project");
  const cakeHome = join(temporaryRoot, "cake-home");
  const sessionId = "file-link-session";
  const timestamp = new Date(0).toISOString();
  const sessionDirectory = cakeWorkspaceSessionDirectory(project, join(cakeHome, "pi", "sessions"));

  await Promise.all([
    mkdir(userData, { recursive: true }),
    mkdir(join(project, "src"), { recursive: true }),
    mkdir(sessionDirectory, { recursive: true }),
  ]);
  await writeFile(join(project, "src", "modelMeta.ts"), "export const meta = 1;\n");
  await writeFile(
    join(userData, "window-state.json"),
    JSON.stringify({
      projectPath: project,
      selectedSessionId: sessionId,
      activeConversation: { kind: "project-session", workspacePath: project, sessionId },
      recentProjectPaths: [project],
      draft: "",
      theme: "dark",
      draftsBySession: {},
    }),
  );
  await writeFile(
    join(userData, "application.json"),
    JSON.stringify({
      schemaVersion: 1,
      projects: [{ path: project, name: "project", addedAt: timestamp, lastOpenedAt: timestamp }],
      resolvedSessionIds: [],
      trustedProjectPaths: [],
    }),
  );
  await writeFile(
    join(sessionDirectory, `${sessionId}.jsonl`),
    [
      { type: "session", version: 3, id: sessionId, timestamp, cwd: project },
      {
        type: "message",
        id: "assistant-final",
        parentId: null,
        timestamp,
        message: {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "Phase 4 — Model references ([`src/modelMeta.ts`](src/modelMeta.ts)) is done.",
            },
          ],
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
    const link = page.locator('a[href="src/modelMeta.ts"]');
    await expect(link).toHaveText("src/modelMeta.ts");
    expect(await link.getAttribute("title")).toBe("Open src/modelMeta.ts in Browse");

    await link.click();

    await expect(page.locator(".workspace-browser")).toBeVisible();
    await expect(page.locator('[aria-label="Workspace file src/modelMeta.ts"]')).toContainText(
      "export const meta = 1;",
    );
  } finally {
    await application.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
