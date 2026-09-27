import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect, type Page } from "@playwright/test";

interface BrowserPaths {
  cakeHome: string;
  project: string;
}

const sessionId = "00000000-0000-4000-8000-000000000001";

export const browserVisualScenarios = [
  {
    name: "browser-shared-chat",
    description: "Chromium shared sidebar, project transcript and composer",
    states: ["default"],
  },
  {
    name: "browser-draw",
    description: "Chromium editable Cake Draw canvas and shared workspace",
    states: ["default"],
  },
  {
    name: "browser-vscode",
    description:
      "Chromium leased, installed code-server inside Cake (requires /opt/homebrew/bin/code-server)",
    states: ["default"],
  },
  {
    name: "browser-mode-hidden",
    description: "Chromium Draw toolbar without desktop-only Browser Mode control",
    states: ["default"],
  },
] as const;

export function findBrowserVisualScenario(name: string) {
  return browserVisualScenarios.find((scenario) => scenario.name === name);
}

export async function seedBrowserVisual(paths: BrowserPaths) {
  const timestamp = new Date(0).toISOString();
  const directory = workspaceSessionDirectory(
    paths.project,
    join(paths.cakeHome, "pi", "sessions"),
  );
  await Promise.all([
    mkdir(directory, { recursive: true }),
    mkdir(join(paths.cakeHome, "state"), { recursive: true }),
    mkdir(paths.project, { recursive: true }),
  ]);
  await writeFile(
    join(paths.project, "qualification.ts"),
    [
      "// An editable project file opened from the Cake conversation.",
      "export function greet(name: string) {",
      "  return `Hello, ${name}!`;",
      "}",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(paths.cakeHome, "state", "application.json"),
    JSON.stringify({
      schemaVersion: 1,
      projects: [
        {
          path: paths.project,
          name: "Browser experience",
          addedAt: timestamp,
          lastOpenedAt: timestamp,
        },
      ],
      trustedProjectPaths: [paths.project],
      ...(existsSync("/opt/homebrew/bin/code-server")
        ? { vscodeServerPath: "/opt/homebrew/bin/code-server" }
        : {}),
    }),
  );
  const assistant = (text: string, id: string, parentId: string) => ({
    type: "message",
    id,
    parentId,
    timestamp,
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      api: "openai-completions",
      provider: "test",
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
  });
  await writeFile(
    join(directory, `1970-01-01T00-00-00-000Z_${sessionId}.jsonl`),
    [
      { type: "session", version: 3, id: sessionId, timestamp, cwd: paths.project },
      {
        type: "message",
        id: "user",
        parentId: null,
        timestamp,
        message: {
          role: "user",
          content: [{ type: "text", text: "Can I use the same Cake workspace in my browser?" }],
          timestamp: 0,
        },
      },
      assistant(
        "Yes. Project sessions, Cake Chat, Draw, and VS Code share the Cake interface. Open [qualification.ts](qualification.ts#L1-L4) in the editor to inspect this project.",
        "answer",
        "user",
      ),
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n") + "\n",
  );
}

function workspaceSessionDirectory(workingDirectory: string, root: string) {
  const normalized = resolve(workingDirectory);
  const safePath = `--${normalized.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return join(resolve(root), safePath);
}

export async function prepareBrowserVisual(page: Page, scenario: string) {
  page.setDefaultTimeout(20_000);
  await page.locator(`[data-slot="sidebar"] [data-session-id="${sessionId}"]`).last().click();
  await expect(
    page.getByText("Can I use the same Cake workspace in my browser?", { exact: true }).last(),
  ).toBeVisible();
  await expect(
    page.getByText(
      "Yes. Project sessions, Cake Chat, Draw, and VS Code share the Cake interface.",
      { exact: false },
    ),
  ).toBeVisible();
  if (scenario === "browser-vscode") {
    if (!existsSync("/opt/homebrew/bin/code-server"))
      throw new Error(
        "browser-vscode requires the installed /opt/homebrew/bin/code-server; no mock editor is substituted",
      );
    await page.getByTitle(/^Open qualification\.ts.*in VS Code$/).click();
    const frame = page.locator('iframe[title="VS Code workspace"]');
    await expect(frame).toHaveAttribute("src", /\/editor\/\d+\/[a-f0-9]{64}\//, {
      timeout: 30_000,
    });
    await expect(frame.contentFrame().locator(".monaco-workbench")).toBeVisible({
      timeout: 30_000,
    });
    await expect(frame.contentFrame().locator(".tab.active")).toContainText("qualification.ts", {
      timeout: 30_000,
    });
    const trust = frame.contentFrame().locator(".monaco-dialog-modal-block");
    if (await trust.isVisible())
      await trust.getByRole("button", { name: /Yes, I trust the authors/ }).click();
  } else if (scenario === "browser-draw") {
    await page.getByRole("button", { name: "Open Cake Draw" }).click();
    const canvas = page.locator(".excalidraw__canvas.interactive");
    await expect(canvas).toBeVisible();
    const box = await canvas.boundingBox();
    if (!box) throw new Error("Draw canvas has no bounds");
    await page.getByRole("radio", { name: "Rectangle" }).click({ force: true });
    await page.mouse.move(box.x + 180, box.y + 130);
    await page.mouse.down();
    await page.mouse.move(box.x + 440, box.y + 280, { steps: 8 });
    await page.mouse.up();
    await expect(page.getByRole("button", { name: "Undo" })).toBeEnabled();
  } else if (scenario === "browser-mode-hidden") {
    await expect(page.getByRole("button", { name: /Browser Mode/ })).toHaveCount(0);
    await page.getByRole("button", { name: "Open Cake Draw" }).click();
    const canvas = page.locator(".excalidraw__canvas.interactive");
    await expect(canvas).toBeVisible();
    const box = await canvas.boundingBox();
    if (!box) throw new Error("Draw canvas has no bounds");
    await page.getByRole("radio", { name: "Rectangle" }).click({ force: true });
    await page.mouse.move(box.x + 180, box.y + 130);
    await page.mouse.down();
    await page.mouse.move(box.x + 440, box.y + 280, { steps: 8 });
    await page.mouse.up();
    await expect(page.getByRole("button", { name: "Undo" })).toBeEnabled();
    await expect(page.getByRole("button", { name: /Browser Mode/ })).toHaveCount(0);
  } else {
    await expect(page.locator('[data-slot="workspace"] textarea').first()).toBeVisible();
  }
  await page.waitForFunction(() => document.fonts.status === "loaded");
  await page.mouse.move(1, 1);
}
