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
      "Initial Cake Chat/sidebar defaults, restoration, manual navigation and links on phone and desktop",
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
    description: "Chromium shared sidebar, project transcript and composer",
    states: ["default"],
  },
  {
    name: "browser-phone-navigation",
    description: "Shared browser navigation drawer at a phone viewport",
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
  if (!(await page.locator('[data-slot="sidebar"]').isVisible()))
    await page.locator('[data-slot="header-sidebar-toggle"]').first().click();
  await page.locator(`[data-slot="sidebar"] [data-session-id="${sessionId}"]`).last().click();
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
  if (scenario === "browser-phone-navigation" || scenario === "browser-phone-settings") {
    await page.locator('[data-slot="header-sidebar-toggle"]').first().click();
    await expect(page.locator('[data-slot="sidebar"]')).toBeVisible();
    if (scenario === "browser-phone-settings") {
      await page
        .locator('[data-slot="sidebar"]')
        .getByRole("button", { name: "Open settings", exact: true })
        .click();
      await page.getByRole("combobox", { name: "Settings section" }).selectOption("network");
      await expect(page.getByRole("heading", { name: "Network & privacy" })).toBeVisible();
    }
  }
  if (scenario === "browser-responsive") {
    const input = page.locator('[data-slot="workspace"] textarea').first();
    if (state === "artifact") {
      await page.getByRole("button", { name: "1 artifacts" }).click();
      await page.getByRole("button", { name: /Mobile layout sample/ }).click();
      await expect(page.getByRole("heading", { name: "Supporting pane" })).toBeVisible();
      const panel = page.getByRole("complementary", { name: "Artifact", exact: true });
      // A short phone pane must not shrink content rows and paint code over history.
      await expect
        .poll(async () => {
          const code = await panel.locator("pre").first().boundingBox();
          const history = await panel
            .getByRole("heading", { name: "Revision history", exact: true })
            .boundingBox();
          return code && history ? history.y - (code.y + code.height) : -Infinity;
        })
        .toBeGreaterThanOrEqual(0);
      const revision = panel.getByRole("combobox", { name: "Selected artifact revision" });
      await revision.scrollIntoViewIfNeeded();
      await expect(revision).toBeInViewport();
      await panel.getByRole("button", { name: "Close Artifact", exact: true }).click();
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
      if (!(await page.locator('[data-slot="sidebar"]').isVisible()))
        await page.locator('[data-slot="header-sidebar-toggle"]').first().click();
      await page
        .locator('[data-slot="sidebar"]')
        .getByRole("button", { name: "Cake Chat", exact: true })
        .first()
        .click();
      await expect(
        page.getByRole("heading", { name: "What can I help you find or do?" }),
      ).toBeVisible();
      if (state === "inspector") {
        await page.getByRole("button", { name: "Inspect context", exact: true }).click();
        await expect(page.getByRole("dialog")).toBeVisible();
      }
    } else if (state === "new-session" || state === "project-settings") {
      if (!(await page.locator('[data-slot="sidebar"]').isVisible()))
        await page.locator('[data-slot="header-sidebar-toggle"]').first().click();
      if (state === "new-session") {
        await page.getByRole("button", { name: "New session", exact: true }).first().click();
      } else {
        await page
          .getByRole("button", { name: /^Open settings for / })
          .first()
          .click();
      }
      await expect(page.getByRole("dialog")).toBeVisible();
    }
  }
  await page.waitForFunction(() => document.fonts.status === "loaded");
  await page.mouse.move(1, 1);
}

async function prepareSidebarDefaults(page: Page, state: string) {
  const phone = await page.evaluate(() => matchMedia("(pointer: coarse)").matches);
  const sidebar = page.locator('[data-slot="sidebar"]');
  const headerToggle = page.locator('[data-slot="header-sidebar-toggle"]').first();
  await expect(headerToggle).toBeAttached();
  const cakeChat = page.getByRole("combobox", { name: "Message Cake Chat", exact: true });
  if (phone) {
    await expect(sidebar).toBeHidden();
    await expect(cakeChat).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "What can I help you find or do?" }),
    ).toBeVisible();
  } else await expect(sidebar).toBeVisible();

  if (state !== "default") {
    // Persist a real visited Project Session (and optionally Settings), including
    // its registry and layout, rather than fabricating a partial navigation record.
    if (!(await sidebar.isVisible())) await headerToggle.click();
    await sidebar.locator(`[data-session-id="${sessionId}"]`).last().click();
    await expect(
      page
        .locator(".transcript")
        .getByText("Can I use the same Cake workspace in my browser?", { exact: true }),
    ).toBeVisible();
    if (state === "restored-settings") {
      if (!(await sidebar.isVisible())) await headerToggle.click();
      await sidebar.getByRole("button", { name: "Open settings", exact: true }).click();
      await expect(page.getByRole("button", { name: "Back to chat", exact: true })).toBeVisible();
    }
    // Seed visibility only after the outgoing page flushes its coherent snapshot.
    await page.addInitScript((hidden) => {
      const key = "cake.browser.presentation.v1";
      const saved = JSON.parse(sessionStorage.getItem(key) ?? '{"state":{},"children":{}}');
      const sidebar = saved.children.sidebarStore ?? { state: {}, children: {} };
      saved.children.sidebarStore = { ...sidebar, state: { ...sidebar.state, hidden } };
      sessionStorage.setItem(key, JSON.stringify(saved));
    }, state === "restored-closed");
    await page.reload();
    await expect(headerToggle).toBeAttached();
    if (phone) {
      await expect(sidebar).toBeHidden();
      await expect(cakeChat).toBeVisible();
    } else if (state === "restored-settings") {
      await expect(page.getByRole("button", { name: "Back to chat", exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Back to chat", exact: true }).click();
    } else {
      await expect(
        page
          .locator(".transcript")
          .getByText("Can I use the same Cake workspace in my browser?", { exact: true }),
      ).toBeVisible();
      if (state === "restored-closed") await expect(sidebar).toBeHidden();
      else await expect(sidebar).toBeVisible();
    }
  }

  if (!(await sidebar.isVisible())) await headerToggle.click();
  await expect(sidebar).toBeVisible();
  await expect(sidebar.getByRole("button", { name: "Open settings", exact: true })).toBeVisible();
  // Ordinary reactive changes must not reapply the initial phone default.
  await sidebar.getByRole("button", { name: "Show activity", exact: true }).click();
  await expect(sidebar).toBeVisible();
  await sidebar.getByRole("button", { name: "Show projects", exact: true }).click();
  await expect(sidebar).toBeVisible();
  await sidebar.getByRole("button", { name: "Toggle sidebar", exact: true }).click();
  await expect(sidebar).toBeHidden();
  await headerToggle.click();
  await expect(sidebar).toBeVisible();
  await sidebar.locator(`[data-session-id="${sessionId}"]`).last().click();
  const input = page.locator('[data-slot="workspace"] textarea').first();
  await expect(input).toBeVisible();
  await expect(
    page
      .locator(".transcript")
      .getByText("Can I use the same Cake workspace in my browser?", { exact: true }),
  ).toBeVisible();
  // Selecting a conversation retains the existing narrow-drawer close behavior.
  if (phone) await expect(sidebar).toBeHidden();
  else await expect(sidebar).toBeVisible();
  const editor = page.getByRole("button", { name: "Open VS Code", exact: true });
  const terminal = page.getByRole("button", { name: "Terminal", exact: true });
  if (phone) {
    await expect(editor).toBeHidden();
    await expect(terminal).toBeHidden();
    await headerToggle.click();
  } else {
    await expect(editor).toBeVisible();
    await expect(terminal).toBeVisible();
  }
  await sidebar.getByRole("button", { name: "Open settings", exact: true }).click();
  await expect(page.getByRole("button", { name: "Back to chat", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Back to chat", exact: true }).click();
  await expect(input).toBeVisible();
  if (phone) await expect(sidebar).toBeHidden();
  else await expect(sidebar).toBeVisible();

  // Viewport changes must not reapply either startup default after manual navigation.
  if (!(await sidebar.isVisible())) await headerToggle.click();
  const viewport = page.viewportSize()!;
  await page.setViewportSize(phone ? { width: 1200, height: 800 } : { width: 500, height: 800 });
  await expect(input).toBeVisible();
  await expect(sidebar).toBeVisible();
  await page.setViewportSize(viewport);
  await expect(input).toBeVisible();
  await expect(sidebar).toBeVisible();

  // Intentional session and exact-message links still select their requested target.
  for (const name of ["original session", "exact request"]) {
    if (!(await sidebar.isVisible())) await headerToggle.click();
    await sidebar.locator(`[data-session-id="${linkSessionId}"]`).last().click();
    await page.getByRole("link", { name, exact: true }).click();
    await expect(
      page
        .locator(".transcript")
        .getByText("Can I use the same Cake workspace in my browser?", { exact: true }),
    ).toBeVisible();
    if (name === "exact request")
      await expect(
        page.locator('[data-slot="transcript-item"][aria-current="true"]'),
      ).toContainText("Can I use the same Cake workspace in my browser?");
    if (phone) await expect(sidebar).toBeHidden();
    else await expect(sidebar).toBeVisible();
  }
  await page.waitForFunction(() => document.fonts.status === "loaded");
  await page.mouse.move(1, 1);
}
