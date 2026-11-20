import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect, type Page } from "@playwright/test";
import { seedArtifact } from "./scenarios.ts";

interface BrowserPaths {
  cakeHome: string;
  project: string;
}

const sessionId = "00000000-0000-4000-8000-000000000001";
const linkSessionId = "00000000-0000-4000-8000-000000000002";

export const browserVisualScenarios = [
  {
    name: "browser-sidebar-defaults",
    description:
      "Cake Chat page entry after reloading a visited session/Workspace/Settings, manual navigation and links on phone and desktop",
    states: ["default", "restored-open", "restored-closed", "restored-settings"],
  },
  {
    name: "browser-responsive",
    description: "Responsive shared shell, composer, header tools and overlays",
    states: [
      "default",
      "multiline",
      "long-draft",
      "model-menu",
      "tree",
      "cake-chat",
      "inspector",
      "new-session",
      "project-settings",
      "tools",
      "artifact",
    ],
  },
  {
    name: "browser-shared-chat",
    description:
      "Chromium shared rail, project transcript and composer; session-menu opens a My sessions row's actions",
    states: ["default", "session-menu"],
  },
  {
    name: "browser-phone-navigation",
    description: "Shared browser Workspace Sessions overlay at a phone viewport",
    states: ["default"],
  },
  {
    name: "browser-phone-settings",
    description: "Shared browser narrow-screen Network & privacy settings",
    states: ["default"],
  },
  {
    name: "browser-vscode",
    description:
      "Chromium leased, installed code-server inside Cake (requires /opt/homebrew/bin/code-server)",
    states: ["default"],
  },
] as const;

export function findBrowserVisualScenario(name: string) {
  return browserVisualScenarios.find((scenario) => scenario.name === name);
}

export async function seedBrowserVisual(paths: BrowserPaths, rich = false) {
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
        "Yes. Project sessions, Cake Chat and VS Code share the Cake interface. Open [qualification.ts](qualification.ts#L1-L4) in the editor to inspect this project.",
        "answer",
        "user",
      ),
      ...(rich
        ? [
            {
              ...assistant("", "inspect", "answer"),
              message: {
                ...assistant("", "inspect", "answer").message,
                content: [
                  {
                    type: "toolCall",
                    id: "read-layout",
                    name: "read",
                    arguments: {
                      path: "src/renderer/components/a-deliberately-long-mobile-layout-file-name.tsx",
                    },
                  },
                ],
                stopReason: "toolUse",
              },
            },
            {
              type: "message",
              id: "read-result",
              parentId: "inspect",
              timestamp,
              message: {
                role: "toolResult",
                toolCallId: "read-layout",
                toolName: "read",
                content: [
                  {
                    type: "text",
                    text: "export const description = 'A long source line that must remain contained inside this tool card rather than widening the chat surface.';",
                  },
                ],
                isError: false,
                timestamp: 2,
              },
            },
            assistant(
              "## Layout findings\n\nThe tool output stays inspectable.\n\n```ts\nconst longPath = 'src/renderer/components/a-deliberately-long-mobile-layout-file-name.tsx';\n```\n\nOpen the [Mobile layout sample](cake://artifact/mobile-layout-sample) to inspect the supporting pane.",
              "findings",
              "read-result",
            ),
          ]
        : []),
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n") + "\n",
  );
  await writeFile(
    join(directory, `1970-01-01T00-00-01-000Z_${linkSessionId}.jsonl`),
    [
      { type: "session", version: 3, id: linkSessionId, timestamp, cwd: paths.project },
      {
        type: "message",
        id: "linked-user",
        parentId: null,
        timestamp,
        message: {
          role: "user",
          content: [
            {
              type: "text",
              text: "Follow the links to the original conversation.",
            },
          ],
          timestamp: 0,
        },
      },
      assistant(
        `Open the [original session](cake://session/${sessionId}) or the [exact request](cake://session/${sessionId}?message=user).`,
        "linked-answer",
        "linked-user",
      ),
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n") + "\n",
  );
  if (rich)
    await seedArtifact(
      paths,
      {
        protocol: "cake.artifact/v1",
        id: "mobile-layout-sample",
        sessionId,
        revision: 1,
        kind: "markdown",
        title: "Mobile layout sample",
        payload: {
          markdown:
            "## Supporting pane\n\nA saved artifact replaces the conversation on a narrow surface. Close it to return to the composer.\n\n```ts\nconst path = 'src/renderer/components/a-deliberately-long-mobile-layout-file-name.tsx';\n```",
        },
        fallback: { markdown: "Mobile layout sample" },
        interaction: { mode: "present" },
      },
      timestamp,
    );
}

function workspaceSessionDirectory(workingDirectory: string, root: string) {
  const normalized = resolve(workingDirectory);
  const safePath = `--${normalized.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return join(resolve(root), safePath);
}

export async function prepareBrowserVisual(page: Page, scenario: string, state = "default") {
  page.setDefaultTimeout(20_000);
  if (scenario === "browser-sidebar-defaults") {
    await prepareSidebarDefaults(page, state);
    return;
  }
  if (scenario === "browser-shared-chat" && state === "session-menu") {
    await prepareSessionMenu(page);
    return;
  }
  await openSession(page, sessionId);
  await expect(
    page.getByText("Can I use the same Cake workspace in my browser?", { exact: true }).last(),
  ).toBeVisible();
  await expect(
    page.getByText("Yes. Project sessions, Cake Chat and VS Code share the Cake interface.", {
      exact: false,
    }),
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
  } else {
    await expect(page.locator('[data-slot="workspace"] textarea').first()).toBeVisible();
  }
  if (scenario === "browser-phone-navigation") await showSessions(page);
  if (scenario === "browser-phone-settings") {
    await rail(page).getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("combobox", { name: "Settings section" }).selectOption("network");
    await expect(page.getByRole("heading", { name: "Network & privacy" })).toBeVisible();
  }
  if (scenario === "browser-responsive") {
    const input = page.locator('[data-slot="workspace"] textarea').first();
    if (state === "artifact") {
      await page.getByRole("button", { name: "1 artifacts" }).click();
      await page.getByRole("button", { name: /Mobile layout sample/ }).click();
      await expect(page.getByRole("heading", { name: "Supporting pane" })).toBeVisible();
      const panel = page.getByRole("complementary", {
        name: "Mobile layout sample",
        exact: true,
      });
      await panel.getByRole("button", { name: "Close Mobile layout sample", exact: true }).click();
      await expect(input).toBeVisible();

      // Revision history belongs to the explicit library, not the selected-artifact pane.
      await page.getByRole("button", { name: "1 artifacts" }).click();
      await page.getByRole("button", { name: "Browse all artifacts", exact: true }).click();
      await page
        .getByRole("navigation", { name: "Artifact lineages", exact: true })
        .getByRole("button", { name: /Mobile layout sample/ })
        .click();
      const history = page.getByRole("heading", { name: "Revision history", exact: true });
      await expect(history).toBeVisible();
      // A short phone detail must not shrink content rows and paint code over history.
      await expect
        .poll(async () => {
          const code = await page
            .locator('[data-artifact-id="mobile-layout-sample"] pre')
            .first()
            .boundingBox();
          const historyBounds = await history.boundingBox();
          return code && historyBounds ? historyBounds.y - (code.y + code.height) : -Infinity;
        })
        .toBeGreaterThanOrEqual(0);
      const revision = page.getByRole("combobox", { name: "Selected artifact revision" });
      await revision.scrollIntoViewIfNeeded();
      await expect(revision).toBeInViewport();
      await page.getByRole("button", { name: "Close all artifacts", exact: true }).click();
      await expect(input).toBeVisible();
      await page.getByRole("button", { name: "1 artifacts" }).click();
      await page.getByRole("button", { name: /Mobile layout sample/ }).click();
      await expect(page.getByRole("heading", { name: "Supporting pane" })).toBeVisible();
    } else if (state === "tools") {
      await page.getByRole("button", { name: "Work log display options", exact: true }).click();
      await page.getByRole("button", { name: "Log view mode", exact: true }).click();
      await page.getByRole("button", { name: "Full work logs", exact: true }).click();
      await page.keyboard.press("Escape");
      await page.locator('[data-slot="tool"]').first().scrollIntoViewIfNeeded();
      await expect(page.locator('[data-slot="tool-details"]').first()).toBeVisible();
    } else if (state === "multiline" || state === "long-draft") {
      await input.fill(
        state === "multiline"
          ? "Please check the mobile layout.\nKeep desktop unchanged.\nInclude screenshot evidence."
          : Array.from(
              { length: 24 },
              (_, index) => `Line ${index + 1}: Keep this long draft editable on a narrow screen.`,
            ).join("\n"),
      );
      await input.focus();
    } else if (state === "model-menu") {
      await page.getByRole("button", { name: "Model configuration", exact: true }).click();
    } else if (state === "tree") {
      await page.getByRole("button", { name: "Session tree", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Session tree", exact: true })).toBeVisible();
    } else if (state === "cake-chat" || state === "inspector") {
      await rail(page).getByRole("button", { name: "Open Cake Chat", exact: true }).click();
      await expect(
        page.getByRole("heading", { name: "What can I help you find or do?" }),
      ).toBeVisible();
      if (state === "inspector") {
        await page.getByRole("button", { name: "Browse context", exact: true }).click();
        await expect(page.getByRole("dialog")).toBeVisible();
      }
    } else if (state === "new-session") {
      await rail(page).getByRole("button", { name: "New session", exact: true }).click();
      await expect(page.getByRole("dialog")).toBeVisible();
    } else if (state === "project-settings") {
      // The browser host opens project actions as an in-page dialog, not a native menu.
      await rail(page)
        .getByRole("button", { name: /^Open Project Chat for / })
        .first()
        .click({ button: "right" });
      await page
        .getByRole("dialog", { name: "Project actions" })
        .getByRole("button", { name: "Project Settings…", exact: true })
        .click();
      await expect(page.getByRole("dialog")).toBeVisible();
    }
  }
  await page.waitForFunction(() => document.fonts.status === "loaded");
  await page.mouse.move(1, 1);
}

/** Seeded sessions have no recorded purpose, so they are My sessions and offer delegation. */
async function prepareSessionMenu(page: Page) {
  await page
    .getByRole("button", { name: "Open Project Chat for Browser experience", exact: true })
    .click();
  await page
    .getByRole("button", { name: /^Sessions / })
    .first()
    .click();
  const tree = page.getByRole("region", { name: "Sessions", exact: true });
  const expand = tree.getByRole("button", { name: "Expand Browser experience", exact: true });
  if (await expand.count()) await expand.click();
  await tree.locator(`[data-session-id="${linkSessionId}"]`).first().click({ button: "right" });
  await expect(
    page
      .getByRole("dialog", { name: "Session actions" })
      .getByRole("button", { name: "Move to Delegated", exact: true }),
  ).toBeVisible();
  await page.waitForFunction(() => document.fonts.status === "loaded");
}

function rail(page: Page) {
  return page.getByRole("navigation", { name: "Projects and global utilities" });
}

/** Opens the Workspace accessory's Sessions source list through the real shell controls. */
async function showSessions(page: Page) {
  const toggle = page.locator('[data-slot="shell-workspace-toggle"]');
  await expect(toggle).toBeVisible();
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  await page
    .getByRole("complementary", { name: "Workspace", exact: true })
    .getByRole("button", { name: /^Sessions / })
    .click();
  const sessions = page.getByRole("region", { name: "Sessions", exact: true });
  await expect(sessions).toBeVisible();
  return sessions;
}

/** Chooses a seeded Project Session from Sessions and waits for it to own the workspace. */
async function openSession(page: Page, id: string) {
  const sessions = await showSessions(page);
  const project = sessions.getByRole("button", { name: "Expand Browser experience", exact: true });
  if (await project.count()) await project.click();
  await sessions.locator(`.session-item[data-session-id="${id}"]`).first().click();
  await expect(page.locator('[data-slot="workspace"]')).toHaveAttribute("data-session-id", id);
}

/**
 * Every page entry starts in global Cake Chat (40566199), whatever was visited before the
 * reload; on phones the Workspace overlay starts collapsed and closes after a choice.
 */
async function prepareSidebarDefaults(page: Page, state: string) {
  const phone = await page.evaluate(() => matchMedia("(pointer: coarse)").matches);
  // The Workspace accessory overlays the conversation only at narrow widths (max-[700px]).
  const overlay = await page.evaluate(() => matchMedia("(max-width: 700px)").matches);
  const toggle = page.locator('[data-slot="shell-workspace-toggle"]');
  const workspace = page.getByRole("complementary", { name: "Workspace", exact: true });
  const cakeChat = page.getByRole("combobox", { name: "Message Cake Chat", exact: true });
  const expectCakeChatEntry = async () => {
    await expect(cakeChat).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "What can I help you find or do?" }),
    ).toBeVisible();
    if (phone && overlay) {
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
      await expect(workspace).toHaveCount(0);
    }
  };
  const transcriptQuestion = page
    .locator(".transcript")
    .getByText("Can I use the same Cake workspace in my browser?", { exact: true });
  await expectCakeChatEntry();

  if (state !== "default") {
    // Visit real surfaces before reloading rather than fabricating saved navigation.
    await openSession(page, sessionId);
    await expect(transcriptQuestion).toBeVisible();
    if (state === "restored-open") await showSessions(page);
    if (state === "restored-closed" && (await toggle.getAttribute("aria-expanded")) === "true")
      await toggle.click();
    if (state === "restored-settings") {
      await rail(page).getByRole("button", { name: "Settings", exact: true }).click();
      await expect(page.getByRole("button", { name: "Back to chat", exact: true })).toBeVisible();
    }
    await page.reload();
    await expectCakeChatEntry();
  }

  // Manual navigation: choose a session, visit Settings and return to that conversation.
  await openSession(page, sessionId);
  const input = page.locator('[data-slot="workspace"] textarea').first();
  await expect(input).toBeVisible();
  await expect(transcriptQuestion).toBeVisible();
  // Where the accessory overlays the conversation, choosing one closes it to reveal it.
  if (overlay) await expect(workspace).toHaveCount(0);
  const editor = page.getByRole("button", { name: "VS Code", exact: true });
  const terminal = page.getByRole("button", { name: "Terminal", exact: true });
  if (phone) {
    await expect(editor).toBeHidden();
    await expect(terminal).toBeHidden();
  } else {
    await expect(editor).toBeVisible();
    await expect(terminal).toBeVisible();
  }
  await rail(page).getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Back to chat", exact: true }).click();
  await expect(input).toBeVisible();
  await expect(page.locator('[data-slot="workspace"]')).toHaveAttribute(
    "data-session-id",
    sessionId,
  );

  // Viewport changes keep the chosen conversation rather than reapplying page entry.
  const viewport = page.viewportSize()!;
  await page.setViewportSize(phone ? { width: 1200, height: 800 } : { width: 500, height: 800 });
  await expect(input).toBeVisible();
  await page.setViewportSize(viewport);
  await expect(input).toBeVisible();
  await expect(page.locator('[data-slot="workspace"]')).toHaveAttribute(
    "data-session-id",
    sessionId,
  );

  // Intentional session and exact-message links still select their requested target.
  for (const name of ["original session", "exact request"]) {
    await openSession(page, linkSessionId);
    // Session links add their target's title to the accessible name; match the visible text.
    await page
      .getByRole("link")
      .filter({ hasText: new RegExp(`^${name}$`) })
      .click();
    await expect(transcriptQuestion).toBeVisible();
    if (name === "exact request")
      await expect(
        page.locator('[data-slot="transcript-item"][aria-current="true"]'),
      ).toContainText("Can I use the same Cake workspace in my browser?");
    if (overlay) await expect(workspace).toHaveCount(0);
  }
  await page.waitForFunction(() => document.fonts.status === "loaded");
  await page.mouse.move(1, 1);
}
