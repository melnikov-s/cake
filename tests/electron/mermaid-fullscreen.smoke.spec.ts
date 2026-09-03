import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { cakeWorkspaceSessionDirectory } from "../../src/services/pi/runtime/session-discovery";

const repositoryRoot = resolve(import.meta.dirname, "../..");

test("stacks a Mermaid diagram's fullscreen view above a fullscreen reader", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "cake-mermaid-fullscreen-smoke-"));
  const userData = join(temporaryRoot, "user-data");
  const project = join(temporaryRoot, "project");
  const cakeHome = join(temporaryRoot, "cake-home");
  const sessionId = "mermaid-fullscreen-session";
  const sessionDirectory = cakeWorkspaceSessionDirectory(project, join(cakeHome, "pi", "sessions"));
  const timestamp = new Date(0).toISOString();
  const assistantMarkdown = [
    "Here is the pipeline:",
    "",
    "```mermaid",
    "graph TD",
    "  A[Cake] --> B[Pi]",
    "  B --> C[Renderer]",
    "```",
    "",
    "Each stage builds on the previous one.",
  ].join("\n");
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
  await mkdir(join(cakeHome, "state"), { recursive: true });
  await writeFile(
    join(cakeHome, "state", "application.json"),
    JSON.stringify({
      schemaVersion: 1,
      projects: [{ path: project, name: "project", addedAt: timestamp, lastOpenedAt: timestamp }],
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
          content: [{ type: "text", text: "Draw the pipeline" }],
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
          content: [{ type: "text", text: assistantMarkdown }],
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
    const diagram = page.locator('[data-streamdown="mermaid"] svg').first();
    await expect(diagram).toBeVisible({ timeout: 20_000 });

    await page.getByRole("button", { name: "View response fullscreen" }).click({ force: true });
    const reader = page.getByRole("dialog", { name: "Cake" });
    await expect(reader).toBeVisible();

    const diagramFullscreen = reader.getByRole("button", { name: "View fullscreen" });
    await expect(diagramFullscreen).toBeVisible();
    await diagramFullscreen.click();

    const overlay = page.locator("body > div.fixed.inset-0.z-50.backdrop-blur-sm");
    await expect(overlay).toBeVisible();

    // The overlay must actually paint above the reader, not behind it.
    const topmost = await page.evaluate(() => {
      const element = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
      return element?.closest("body > div")?.className ?? "";
    });
    expect(topmost).toContain("backdrop-blur-sm");

    await page.keyboard.press("Escape");
    await expect(overlay).toHaveCount(0);
    await expect(reader).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(reader).toHaveCount(0);
  } finally {
    await application.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
