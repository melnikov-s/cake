import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Locator, Page } from "@playwright/test";
import type { VisualCaptureTheme } from "./arguments.ts";

interface ScenarioFixturePaths {
  readonly cakeHome: string;
  readonly project: string;
  readonly userData: string;
}

interface VisualCaptureScenario {
  readonly name: string;
  readonly description: string;
  readonly states: readonly string[];
  seed(paths: ScenarioFixturePaths, theme: VisualCaptureTheme): Promise<void>;
  prepare(page: Page, state: string): Promise<void>;
  region(page: Page): Locator;
}

const assistantMarkdown = [
  "## Repository-owned visual checks",
  "",
  "Use the capture harness whenever a Cake UI change benefits from a visual review.",
  "",
  "```tsx",
  "interface CaptureResult {",
  "  scenario: string;",
  '  state: "default" | "hover";',
  "  outputPath: string;",
  "}",
  "```",
  "",
  "> Named scenarios keep setup and interaction deterministic.",
].join("\n");

const assistantMarkdownCode: VisualCaptureScenario = {
  name: "assistant-markdown-code",
  description: "Assistant Markdown with a highlighted TypeScript code block",
  states: ["default", "hover"],
  async seed(paths, theme) {
    const sessionId = "visual-assistant-markdown-code";
    const timestamp = new Date(0).toISOString();
    const sessionDirectory = workspaceSessionDirectory(
      paths.project,
      join(paths.cakeHome, "pi", "sessions"),
    );
    await Promise.all([
      mkdir(paths.userData, { recursive: true }),
      mkdir(paths.project, { recursive: true }),
      mkdir(sessionDirectory, { recursive: true }),
      mkdir(join(paths.cakeHome, "state"), { recursive: true }),
    ]);
    await writeFile(
      join(paths.userData, "window-state.json"),
      JSON.stringify({
        projectPath: paths.project,
        selectedSessionId: sessionId,
        activeConversation: {
          kind: "project-session",
          workspacePath: paths.project,
          sessionId,
        },
        recentProjectPaths: [paths.project],
        draft: "",
        draftsBySession: {},
        theme,
      }),
    );
    await writeFile(
      join(paths.cakeHome, "state", "application.json"),
      JSON.stringify({
        schemaVersion: 1,
        projects: [
          {
            path: paths.project,
            name: "visual-capture-project",
            addedAt: timestamp,
            lastOpenedAt: timestamp,
          },
        ],
        trustedProjectPaths: [],
      }),
    );
    await writeFile(
      join(sessionDirectory, `1970-01-01T00-00-00-000Z_${sessionId}.jsonl`),
      `${[
        { type: "session", version: 3, id: sessionId, timestamp, cwd: paths.project },
        {
          type: "message",
          id: "user-1",
          parentId: null,
          timestamp,
          message: {
            role: "user",
            content: [{ type: "text", text: "How should agents capture Cake UI changes?" }],
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
            model: "visual-fixture",
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
        .join("\n")}\n`,
    );
  },
  async prepare(page, state) {
    const code = page.locator('[data-streamdown="code-block-body"] code');
    await code.waitFor({ state: "visible", timeout: 20_000 });
    await page.waitForFunction(() => document.fonts.status === "loaded");
    await page.waitForFunction(() =>
      Array.from(
        document.querySelectorAll<HTMLElement>(
          '[data-streamdown="code-block-body"] code span span',
        ),
      ).some((token) => token.style.getPropertyValue("--sdm-c") !== "inherit"),
    );

    if (state === "hover") {
      await page.locator(".group\\/code").hover();
      await page.waitForFunction(() => {
        const button = document.querySelector<HTMLElement>(
          '[data-streamdown="code-block-copy-button"]',
        );
        return button !== null && Number.parseFloat(getComputedStyle(button).opacity) === 1;
      });
    } else {
      await page.mouse.move(1, 1);
    }
  },
  region(page) {
    return page
      .locator('[data-slot="message"]')
      .filter({ has: page.locator('[data-streamdown="code-block-body"]') })
      .locator('[data-slot="message-content"]');
  },
};

export const visualCaptureScenarios = [assistantMarkdownCode] as const;

export function findVisualCaptureScenario(name: string) {
  return visualCaptureScenarios.find((scenario) => scenario.name === name);
}

/** Mirrors Cake/Pi's per-working-directory session layout for an isolated fixture. */
function workspaceSessionDirectory(workingDirectory: string, root: string) {
  const normalized = resolve(workingDirectory);
  const safePath = `--${normalized.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return join(resolve(root), safePath);
}
