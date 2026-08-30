import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { cakeWorkspaceSessionDirectory } from "../../src/agent/session-discovery";

const repositoryRoot = resolve(import.meta.dirname, "../..");

function assistantToolCall(
  id: string,
  parentId: string,
  timestamp: string,
  toolCallId: string,
  name: string,
  argumentsValue: object,
) {
  return {
    type: "message",
    id,
    parentId,
    timestamp,
    message: {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: toolCallId,
          name: "cake",
          arguments: { command: name, input: argumentsValue },
        },
      ],
      api: "openai-codex-responses",
      provider: "openai-codex",
      model: "gpt-5.6-sol",
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
  };
}

function toolResult(
  id: string,
  parentId: string,
  timestamp: string,
  toolCallId: string,
  toolName: string,
  result: object,
) {
  return {
    type: "message",
    id,
    parentId,
    timestamp,
    message: {
      role: "toolResult",
      toolCallId,
      toolName: "cake",
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      details: { protocol: "cake.operation/v1", command: toolName, result },
      isError: false,
      timestamp: 2,
    },
  };
}

test("opens a released subagent in a read-only popup chat", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "cake-subagent-work-log-smoke-"));
  const userData = join(temporaryRoot, "user-data");
  const project = join(temporaryRoot, "project");
  const cakeHome = join(temporaryRoot, "cake-home");
  const sessionId = "subagent-work-log-session";
  const handleId = "8fd5d243-7a94-4d49-a763-be136ffa64f0";
  const timestamp = new Date(0).toISOString();
  const sessionDirectory = cakeWorkspaceSessionDirectory(project, join(cakeHome, "pi", "sessions"));
  const request = {
    task: "Tell one short programming joke.",
    profile: "worker",
    model: {
      prefer: "exact",
      provider: "openai-codex",
      modelId: "gpt-5.6-sol",
      thinkingLevel: "max",
    },
    instructions: "Return only the joke.",
    fastMode: true,
    maxDepth: 0,
    retain: false,
  };
  const resolvedModel = {
    requested: "exact",
    source: "exact",
    provider: "openai-codex",
    modelId: "gpt-5.6-sol",
    thinkingLevel: "max",
    fallbacks: [],
  };

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
          content: [{ type: "text", text: "Delegate a joke." }],
          timestamp: 0,
        },
      },
      assistantToolCall(
        "spawn-call",
        "user-1",
        timestamp,
        "call-spawn",
        "subagents.start",
        request,
      ),
      toolResult("spawn-result", "spawn-call", timestamp, "call-spawn", "subagents.start", {
        handleId,
        task: request.task,
        profile: request.profile,
        status: "running",
        retained: false,
        fastMode: true,
        maxDepth: 0,
        resolvedModel,
      }),
      assistantToolCall("poll-call", "spawn-result", timestamp, "call-poll", "subagents.wait", {
        handleId,
      }),
      toolResult("poll-result", "poll-call", timestamp, "call-poll", "subagents.wait", {
        handleId,
        task: request.task,
        profile: request.profile,
        status: "running",
        resolvedModel,
        streaming: true,
        parts: [],
      }),
      assistantToolCall("wait-call", "poll-result", timestamp, "call-wait", "subagents.wait", {
        handleId,
      }),
      toolResult("wait-result", "wait-call", timestamp, "call-wait", "subagents.wait", {
        handleId,
        task: request.task,
        profile: request.profile,
        status: "complete",
        resolvedModel,
        fastMode: true,
        streaming: false,
        parts: [
          {
            id: "child-answer",
            kind: "text",
            role: "assistant",
            text: "The loop opened a bakery because it knew how to roll.",
            status: "complete",
          },
        ],
        usage: {
          tokens: { input: 100, output: 25, cacheRead: 0, cacheWrite: 0, total: 125 },
          cost: 0.002,
        },
      }),
      {
        type: "message",
        id: "assistant-final",
        parentId: "wait-result",
        timestamp,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Here is the delegated joke." }],
          api: "openai-codex-responses",
          provider: "openai-codex",
          model: "gpt-5.6-sol",
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
    const log = page.locator('[data-slot="activity-group"]');
    await expect(log).toHaveCount(1, { timeout: 20_000 });
    await expect(log.locator(":scope > summary")).toContainText("1 tool call");

    await log.locator(":scope > summary").click();
    const subagent = log.locator('[data-slot="subagent-call"]');
    await expect(subagent).toHaveCount(1);
    await expect(subagent).toContainText("Tell one short programming joke");
    await expect(subagent).toContainText("Background · 2 waits");
    await expect(subagent).toContainText("openai-codex/gpt-5.6-sol");
    await expect(subagent).toContainText("Released");
    await expect(subagent).not.toContainText(
      "The loop opened a bakery because it knew how to roll.",
    );

    await subagent.getByRole("button", { name: "Open worker subagent chat" }).click();
    const popup = page.getByRole("dialog", { name: "worker subagent" });
    await expect(popup).toContainText("Released");
    await expect(popup).toContainText("The loop opened a bakery because it knew how to roll.");
    await expect(popup.locator("textarea")).toHaveCount(0);
    await popup.getByRole("button", { name: "Close worker subagent" }).click();

    const status = page.getByRole("button", { name: "0 subagents running" });
    await expect(status).toBeVisible();
    await status.click();
    const activeList = page.getByRole("dialog", { name: "Active subagents" });
    await expect(activeList).toContainText("No subagents are running.");
  } finally {
    await application.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("never restores an interrupted subagent as running", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "cake-subagent-stale-smoke-"));
  const userData = join(temporaryRoot, "user-data");
  const project = join(temporaryRoot, "project");
  const cakeHome = join(temporaryRoot, "cake-home");
  const sessionId = "subagent-stale-session";
  const handleId = "1f686b2d-c41f-44df-9ba9-e3c3b4065c6c";
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
          content: [{ type: "text", text: "Delegate work." }],
          timestamp: 0,
        },
      },
      assistantToolCall("spawn-call", "user-1", timestamp, "call-spawn", "subagents.start", {
        task: "Background work that never finished.",
        profile: "worker",
      }),
      toolResult("spawn-result", "spawn-call", timestamp, "call-spawn", "subagents.start", {
        handleId,
        task: "Background work that never finished.",
        profile: "worker",
        status: "running",
      }),
      // The previous process quit while waiting; no result was ever recorded.
      assistantToolCall("wait-call", "spawn-result", timestamp, "call-wait", "subagents.wait", {
        handleId,
      }),
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
    const log = page.locator('[data-slot="activity-group"]');
    await expect(log).toHaveCount(1, { timeout: 20_000 });
    await log.locator(":scope > summary").click();
    const subagent = log.locator('[data-slot="subagent-call"]');
    await expect(subagent).toHaveCount(1);
    await expect(subagent).toHaveAttribute("data-status", "released");
    await expect(subagent).toContainText("Released");
  } finally {
    await application.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
