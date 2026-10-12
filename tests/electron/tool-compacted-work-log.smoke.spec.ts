import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { projectConversationDisplay } from "../../src/services/pi/runtime/conversation-display-projection";
import { cakeWorkspaceSessionDirectory } from "../../src/services/pi/runtime/session-discovery";
import { addResponseModeReminder } from "../../src/contracts/conversations/response-mode-reminders";
import { addPresentationModeReminder } from "../../src/contracts/conversations/presentation-mode-reminders";
import { encodeCrossSessionMessage } from "../../src/contracts/conversations/cross-session-message";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const timestamp = new Date(0).toISOString();
const canonicalSystem = {
  role: "system",
  content: "",
  sections: { rules: "Required canonical instructions" },
  timestamp: 0,
};
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
    { type: "message", id: "source-system", parentId: null, timestamp, message: canonicalSystem },
    {
      type: "message",
      id: "source-user",
      parentId: "source-system",
      timestamp,
      message: {
        role: "user",
        content: addResponseModeReminder(
          addPresentationModeReminder("Inspect it", "normal", "draw"),
          "text",
        ),
        timestamp: 0,
      },
    },
    {
      type: "custom_message",
      id: "source-cake-context",
      parentId: "source-user",
      timestamp,
      customType: "Cake reminder",
      content: "Hidden Cake context sent to the model.",
      display: false,
    },
    {
      type: "custom_message",
      id: "source-extension-context",
      parentId: "source-cake-context",
      timestamp,
      customType: "Extension reminder",
      content: "Extension context sent to the model.",
      display: true,
    },
    {
      type: "message",
      id: "source-assistant-work",
      parentId: "source-extension-context",
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
      type: "message",
      id: "canonical-checkpoint",
      parentId: null,
      timestamp,
      message: canonicalSystem,
    },
    {
      type: "custom",
      id: "compact-marker",
      parentId: "canonical-checkpoint",
      timestamp,
      customType: "cake.tool-compact/v1",
      data: {
        summary: "Earlier work was tool compacted.",
        systemCheckpointEntryId: "canonical-checkpoint",
      },
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
      id: "changed-system",
      parentId: "compact-provenance",
      timestamp,
      message: {
        ...canonicalSystem,
        sections: { rules: "## Genuinely changed instructions\n\nUse **Markdown** for context." },
        toolsAdded: [{ name: "read", description: "Read a file", parameters: { type: "object" } }],
        timestamp: 3,
      },
    },
    {
      type: "message",
      id: "current-user",
      parentId: "changed-system",
      timestamp,
      message: {
        role: "user",
        content: [
          {
            type: "text",
            text: addResponseModeReminder(
              encodeCrossSessionMessage("Check again", {
                version: 1,
                messageId: "00000000-0000-4000-8000-000000000001",
                threadId: "00000000-0000-4000-8000-000000000002",
                sequence: 1,
                expectsResponse: true,
                sender: { kind: "cake-chat", sessionId: "coordinator", title: "Cake Chat" },
              }),
              "text",
            ),
          },
          {
            type: "image",
            mimeType: "image/png",
            data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7X8AAAAASUVORK5CYII=",
          },
        ],
        timestamp: 3,
      },
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

  const fixtureParts = projectConversationDisplay(
    SessionManager.open(join(sessionDirectory, `1970-01-01T00-00-00-000Z_${sessionId}.jsonl`)),
  );
  expect(fixtureParts.filter((part) => part.kind === "context" && part.title === "System")).toEqual(
    [
      expect.objectContaining({ origin: "compacted" }),
      expect.objectContaining({ text: expect.stringContaining("Genuinely changed instructions") }),
    ],
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
    const groups = page.locator('[data-slot="activity-group"]');
    await expect(groups).toHaveCount(2, { timeout: 20_000 });
    await expect(page.getByText("Check again", { exact: true })).toBeVisible();
    const incoming = page.getByRole("region", { name: "Message from another session" });
    await expect(incoming.getByRole("link", { name: "Cake Chat", exact: true })).toHaveAttribute(
      "href",
      "cake://session/coordinator",
    );
    await expect(incoming).toContainText("Check again");
    await expect(page.getByRole("img", { name: "Image 2", exact: true })).toBeVisible();
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
    await compacted.locator(":scope > summary").click();
    const cakePill = page.getByRole("button", {
      name: "Cake reminder · removed from context",
      exact: true,
    });
    const extensionPill = page.getByRole("button", {
      name: "Extension reminder · removed from context",
      exact: true,
    });
    await expect(cakePill).toBeVisible();
    await expect(extensionPill).toBeVisible();
    await cakePill.click();
    await expect(
      page.getByText("Hidden Cake context sent to the model.", { exact: true }),
    ).toBeVisible();
    const expandedLayout = await cakePill.evaluate((trigger) => {
      const panel = document.getElementById(trigger.getAttribute("aria-controls") ?? "");
      const group = trigger.closest('[data-slot="context-group"]');
      if (!panel || !group) throw new Error("Missing context disclosure");
      return {
        panelWidth: panel.getBoundingClientRect().width,
        groupWidth: group.getBoundingClientRect().width,
        panelTop: panel.getBoundingClientRect().top,
        triggerBottom: trigger.getBoundingClientRect().bottom,
      };
    });
    expect(Math.abs(expandedLayout.panelWidth - expandedLayout.groupWidth)).toBeLessThan(2);
    expect(expandedLayout.panelTop).toBeGreaterThan(expandedLayout.triggerBottom);
    const openBoxes = await Promise.all([cakePill.boundingBox(), extensionPill.boundingBox()]);
    expect(openBoxes[0]).not.toBeNull();
    expect(openBoxes[1]).not.toBeNull();
    expect(Math.abs(openBoxes[0]!.y - openBoxes[1]!.y)).toBeLessThan(2);
    await cakePill.click();
    const boxes = await Promise.all([cakePill.boundingBox(), extensionPill.boundingBox()]);
    expect(boxes[0]).not.toBeNull();
    expect(boxes[1]).not.toBeNull();
    expect(Math.abs(boxes[0]!.y - boxes[1]!.y)).toBeLessThan(2);
    expect(boxes[1]!.x).toBeGreaterThan(boxes[0]!.x);
    await extensionPill.click();
    await expect(
      page.getByText("Extension context sent to the model.", { exact: true }),
    ).toBeVisible();
    // The genuine instruction change stays inspectable even if the runtime
    // materializes its current prompt while this initially passive preview is open.
    const systemChange = page
      .locator('[data-part-id="entry-changed-system-system-prompt-system"]')
      .getByRole("button", { name: "System", exact: true });
    await expect(systemChange).toHaveCount(1);
    await systemChange.click();
    await expect(
      page.getByRole("heading", { name: "Genuinely changed instructions" }),
    ).toBeVisible();
    await expect(page.locator('[data-slot="context-pill"] [data-streamdown="strong"]')).toHaveText(
      "Markdown",
    );
    await systemChange.click();
    await page.getByRole("button", { name: "Tools", exact: true }).click();
    await expect(page.locator('[data-slot="context-pill"] pre')).toContainText('"name": "read"');
    // This unopened-runtime preview shows the original event and genuine change,
    // but does not mistake the carried checkpoint for another injection.
    const currentReminder = page.getByRole("button", { name: "Cake · response mode", exact: true });
    await expect(currentReminder).toBeVisible();
    await currentReminder.click();
    await expect(
      page
        .locator('[data-slot="context-pill"][data-origin="current"]')
        .filter({ has: currentReminder }),
    ).toContainText("Cake response mode: text");
    await expect(page.getByText("Original answer.", { exact: true })).toBeVisible();
    await expect(page.getByText("Current answer.", { exact: true })).toBeVisible();
  } finally {
    await application.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
