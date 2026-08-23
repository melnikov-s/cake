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
      content: [{ type: "toolCall", id: toolCallId, name, arguments: argumentsValue }],
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
      toolName,
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      details: result,
      isError: false,
      timestamp: 2,
    },
  };
}

test("shows one detailed pill for a subagent spawn and result", async () => {
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
      assistantToolCall("spawn-call", "user-1", timestamp, "call-spawn", "subagent_spawn", request),
      toolResult("spawn-result", "spawn-call", timestamp, "call-spawn", "subagent_spawn", {
        handleId,
        task: request.task,
        profile: request.profile,
        status: "running",
        retained: false,
        fastMode: true,
        maxDepth: 0,
        resolvedModel,
      }),
      assistantToolCall("wait-call", "spawn-result", timestamp, "call-wait", "subagent_wait", {
        handleId,
      }),
      toolResult("wait-result", "wait-call", timestamp, "call-wait", "subagent_wait", {
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
    const log = page.locator(".activity-group");
    await expect(log).toHaveCount(1, { timeout: 20_000 });
    await expect(log.locator(":scope > summary")).toContainText("1 tool call");

    await log.locator(":scope > summary").click();
    await expect(log.locator(".subagent-call")).toHaveCount(1);
    await expect(log.locator(".subagent-summary")).toContainText("openai-codex/gpt-5.6-sol");
    await expect(log.locator(".subagent-summary")).toContainText("max");
    await expect(log.locator(".subagent-result")).toContainText(
      "The loop opened a bakery because it knew how to roll.",
    );

    await log.locator(".subagent-summary").click();
    await expect(log.locator(".subagent-details")).toContainText("Requested model");
    await expect(
      log.locator(".subagent-metadata > div").filter({ hasText: "Fast mode" }),
    ).toContainText("On");
    await expect(log.locator(".subagent-details")).toContainText("Return only the joke.");
  } finally {
    await application.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
