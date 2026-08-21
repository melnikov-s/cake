import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { cakeWorkspaceSessionDirectory } from "../../src/agent/session-discovery";

const repositoryRoot = resolve(import.meta.dirname, "../..");

test("does not mount collapsed work-log activity until it is expanded", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "cake-work-log-smoke-"));
  const userData = join(temporaryRoot, "user-data");
  const project = join(temporaryRoot, "project");
  const cakeHome = join(temporaryRoot, "cake-home");
  const sessionId = "work-log-session";
  const timestamp = new Date(0).toISOString();
  const sessionDirectory = cakeWorkspaceSessionDirectory(project, join(cakeHome, "pi", "sessions"));

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
      theme: "dark",
      thinkingExpanded: false,
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
        id: "user-1",
        parentId: null,
        timestamp,
        message: {
          role: "user",
          content: [{ type: "text", text: "Read the project" }],
          timestamp: 0,
        },
      },
      {
        type: "message",
        id: "assistant-tools",
        parentId: "user-1",
        timestamp,
        message: {
          role: "assistant",
          content: [
            { type: "toolCall", id: "call-1", name: "read", arguments: { path: "README.md" } },
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
          stopReason: "toolUse",
          timestamp: 1,
        },
      },
      {
        type: "message",
        id: "tool-result",
        parentId: "assistant-tools",
        timestamp,
        message: {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "read",
          content: [{ type: "text", text: "README contents" }],
          isError: false,
          timestamp: 2,
        },
      },
      {
        type: "message",
        id: "assistant-final",
        parentId: "tool-result",
        timestamp,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "The project is readable." }],
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
          timestamp: 3,
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
    const log = page.locator(".activity-group");
    await expect(log).toHaveCount(1, { timeout: 20_000 });
    await expect(log.locator(":scope > div")).toHaveCount(0);
    await expect(log.locator(".tool-call")).toHaveCount(0);

    await log.locator(":scope > summary").click();
    await expect(log).toHaveAttribute("open", "");
    await expect(log.locator(".tool-call")).toHaveCount(1);

    await log.locator(":scope > summary").click();
    await expect(log).not.toHaveAttribute("open", "");
    await expect(log.locator(":scope > div")).toHaveCount(0);
    await expect(log.locator(".tool-call")).toHaveCount(0);
  } finally {
    await application.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
