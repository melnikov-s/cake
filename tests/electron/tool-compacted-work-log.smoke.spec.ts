import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { cakeWorkspaceSessionDirectory } from "../../src/services/pi/runtime/session-discovery";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const timestamp = new Date(0).toISOString();
const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(content: unknown[]) {
  return {
    role: "assistant",
    content,
    api: "anthropic-messages",
    provider: "anthropic",
    model: "fixture",
    usage,
    stopReason: "stop",
    timestamp: 1,
  };
}

test("shows compacted historical work in place, muted and expandable", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "cake-compacted-work-log-smoke-"));
  const userData = join(temporaryRoot, "user-data");
  const project = join(temporaryRoot, "project");
  const cakeHome = join(temporaryRoot, "cake-home");
  const sessionId = "compacted-work-log-session";
  const sessionDirectory = cakeWorkspaceSessionDirectory(project, join(cakeHome, "pi", "sessions"));

  await Promise.all([
    mkdir(userData, { recursive: true }),
    mkdir(project, { recursive: true }),
    mkdir(sessionDirectory, { recursive: true }),
    mkdir(join(cakeHome, "state"), { recursive: true }),
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
    join(cakeHome, "state", "application.json"),
    JSON.stringify({
      schemaVersion: 1,
      projects: [{ path: project, name: "project", addedAt: timestamp, lastOpenedAt: timestamp }],
      trustedProjectPaths: [],
    }),
  );
  const entries = [
    { type: "session", version: 3, id: sessionId, timestamp, cwd: project },
    {
      type: "message",
      id: "source-user",
      parentId: null,
      timestamp,
      message: { role: "user", content: "Inspect it", timestamp: 0 },
    },
    {
      type: "message",
      id: "source-assistant-work",
      parentId: "source-user",
      timestamp,
      message: assistant([
        { type: "text", text: "I inspected it." },
        { type: "thinking", thinking: "Historical reasoning remains readable." },
        { type: "toolCall", id: "historical-read", name: "read", arguments: { path: "old.ts" } },
      ]),
    },
    {
      type: "message",
      id: "source-result",
      parentId: "source-assistant-work",
      timestamp,
      message: {
        role: "toolResult",
        toolCallId: "historical-read",
        toolName: "read",
        content: [{ type: "text", text: "Historical tool output" }],
        isError: false,
        timestamp: 2,
      },
    },
    {
      type: "message",
      id: "source-final",
      parentId: "source-result",
      timestamp,
      message: assistant([{ type: "text", text: "Original answer." }]),
    },
    {
      type: "custom_message",
      id: "compact-marker",
      parentId: null,
      timestamp,
      customType: "cake.tool-compact/v1",
      content: "Earlier work was tool compacted.",
      display: true,
    },
    {
      type: "message",
      id: "replay-user",
      parentId: "compact-marker",
      timestamp,
      message: { role: "user", content: "Inspect it", timestamp: 0 },
    },
    {
      type: "message",
      id: "replay-assistant-work",
      parentId: "replay-user",
      timestamp,
      message: assistant([{ type: "text", text: "I inspected it." }]),
    },
    {
      type: "message",
      id: "replay-final",
      parentId: "replay-assistant-work",
      timestamp,
      message: assistant([{ type: "text", text: "Original answer." }]),
    },
    {
      type: "custom",
      id: "compact-provenance",
      parentId: "replay-final",
      timestamp,
      customType: "cake.tool-compact-provenance/v1",
      data: {
        version: 1,
        sourceLeafId: "source-final",
        markerEntryId: "compact-marker",
        replayStartEntryId: "replay-user",
        replayEndEntryId: "replay-final",
        mappings: [
          { sourceEntryId: "source-user", replayedEntryId: "replay-user" },
          { sourceEntryId: "source-assistant-work", replayedEntryId: "replay-assistant-work" },
          { sourceEntryId: "source-final", replayedEntryId: "replay-final" },
        ],
      },
    },
    {
      type: "message",
      id: "current-user",
      parentId: "compact-provenance",
      timestamp,
      message: { role: "user", content: "Check again", timestamp: 3 },
    },
    {
      type: "message",
      id: "current-work",
      parentId: "current-user",
      timestamp,
      message: assistant([
        { type: "thinking", thinking: "Current reasoning" },
        { type: "toolCall", id: "current-read", name: "read", arguments: { path: "new.ts" } },
      ]),
    },
    {
      type: "message",
      id: "current-result",
      parentId: "current-work",
      timestamp,
      message: {
        role: "toolResult",
        toolCallId: "current-read",
        toolName: "read",
        content: [{ type: "text", text: "Current tool output" }],
        isError: false,
        timestamp: 4,
      },
    },
    {
      type: "message",
      id: "current-final",
      parentId: "current-result",
      timestamp,
      message: assistant([{ type: "text", text: "Current answer." }]),
    },
  ];
  await writeFile(
    join(sessionDirectory, `1970-01-01T00-00-00-000Z_${sessionId}.jsonl`),
    `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
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
    const groups = page.locator('[data-slot="activity-group"]');
    await expect(groups).toHaveCount(2, { timeout: 20_000 });
    const compacted = page.locator('[data-slot="activity-group"][data-origin="compacted"]');
    await expect(compacted).toHaveCount(1);
    await expect(compacted.locator(":scope > summary")).toContainText("Compacted work log");
    await expect(compacted).toHaveAttribute("data-origin", "compacted");
    await expect(compacted).not.toHaveAttribute("open", "");
    await expect(page.locator('[data-slot="activity-group"][data-origin="current"]')).toHaveCount(
      1,
    );

    await compacted.locator(":scope > summary").click();
    await expect(compacted).toHaveAttribute("open", "");
    await compacted.getByRole("button", { name: /Reasoning/ }).click();
    await expect(compacted).toContainText("Historical reasoning remains readable.");
    await compacted.getByRole("button", { name: /read/i }).first().click();
    await expect(compacted).toContainText("Historical tool output");
    await expect(page.getByText("Original answer.", { exact: true })).toBeVisible();
    await expect(page.getByText("Current answer.", { exact: true })).toBeVisible();
  } finally {
    await application.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
