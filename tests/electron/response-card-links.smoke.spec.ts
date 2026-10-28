import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness, createRegistry, UserEntry } from "@earendil-works/pi-durable";
import { createModels } from "@earendil-works/pi-durable-ai";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { _electron as electron, expect, test } from "@playwright/test";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { findVisualCaptureScenario } from "../../scripts/visual-capture/scenarios";
import { encodeCrossSessionMessage } from "../../src/contracts/conversations/cross-session-message";
import { durableInputText } from "../../src/services/pi-durable/durable-input-presentation";
import { cakeWorkspaceSessionDirectory } from "../../src/services/pi/runtime/session-discovery";

const repository = resolve(import.meta.dirname, "../..");

test("Project Chat response cards route conversation links, report missing files and keep tool names literal", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cake-response-card-links-"));
  const paths = {
    cakeHome: join(directory, "cake-home"),
    project: join(directory, "project"),
    userData: join(directory, "user-data"),
  };
  await findVisualCaptureScenario("assistant-markdown-code")!.seed(paths, "dark");
  const producer = SessionManager.create(
    paths.project,
    cakeWorkspaceSessionDirectory(paths.project, join(paths.cakeHome, "pi", "sessions")),
    { id: randomUUID() },
  );
  producer.appendSessionInfo("Make Excalidraw diagram creation fast and discoverable");
  producer.appendMessage({ role: "user", content: "Original diagram investigation", timestamp: 1 });
  const child = SessionManager.create(
    paths.project,
    cakeWorkspaceSessionDirectory(paths.project, join(paths.cakeHome, "pi", "sessions")),
    { id: randomUUID() },
  );
  child.appendSessionInfo("Fresh drawing trial");
  child.appendMessage({
    role: "user",
    timestamp: 2,
    content: encodeCrossSessionMessage(
      `Read workgroups.md and sessions.md. Your assignment is already persisted on the family Workboard: entry #1, topic child-${child.getSessionId()}. Read it with boards.read before working. Communicate with family members only on the Workboard.`,
      {
        version: 1,
        messageId: child.getSessionId(),
        threadId: producer.getSessionId(),
        sequence: 1,
        expectsResponse: false,
        resultDelivery: "ignore",
        sender: {
          sessionId: producer.getSessionId(),
          title: `Parent session ${producer.getSessionId()}`,
          kind: "project-session",
        },
      },
    ),
  });
  const hash = createHash("sha256").update(paths.project).digest("hex");
  const chatDirectory = join(paths.cakeHome, "pi", "project-chats", hash);
  await mkdir(chatDirectory, { recursive: true });
  const storage = await openNodeSqliteStorage(join(chatDirectory, "coordinator.sqlite"));
  const harness = await Harness.open(
    storage,
    { models: createModels(), registry: createRegistry() },
    BACKGROUND_CONTEXT,
  );
  try {
    const conversation = await harness.root(BACKGROUND_CONTEXT);
    await conversation.commit(async (tx) => {
      await tx.appendEntry(UserEntry, conversation.id, {
        model: [
          {
            role: "user",
            timestamp: 3,
            content: durableInputText("", [], true, false, undefined, undefined, {
              _tag: "AgentUpdate",
              update: {
                id: "response-card",
                text: "Read workgroups.md and sessions.md with boards.read. Also [workspace document](../reference.md).",
                source: {
                  title: "Investigation update",
                  href: `cake://session/${producer.getSessionId()}`,
                },
              },
            }),
          },
        ],
      });
    }, BACKGROUND_CONTEXT);
  } finally {
    await harness.close(BACKGROUND_CONTEXT);
    await storage.close(BACKGROUND_CONTEXT);
  }
  await writeFile(
    join(directory, "reference.md"),
    "# Reference document\n\nUseful document content.",
  );
  const app = await electron.launch({
    args: [repository],
    cwd: repository,
    env: {
      ...process.env,
      CAKE_ELECTRON_SMOKE: "1",
      CAKE_HOME: paths.cakeHome,
      CAKE_ELECTRON_USER_DATA: paths.userData,
      PI_CODING_AGENT_DIR: join(paths.cakeHome, "pi"),
      PI_CODING_AGENT_SESSION_DIR: "",
    },
  });
  try {
    const page = await app.firstWindow();
    await expect(
      page.getByRole("heading", { name: "Repository-owned visual checks" }),
    ).toBeVisible();
    await page
      .locator(`.session-item[data-session-id="${child.getSessionId()}"] .session-row > button`)
      .click();
    // Startup instructions are application context, not a response from the parent.
    const bootstrap = page.getByRole("button", { name: "Family bootstrap", exact: true });
    await expect(bootstrap).toBeVisible();
    await bootstrap.click();
    const startupContext = page.locator('[data-slot="context-pill"]').filter({ has: bootstrap });
    for (const name of ["workgroups.md", "sessions.md", "boards.read"])
      await expect(startupContext.getByRole("link", { name, exact: true })).toHaveCount(0);
    await expect(startupContext.locator("code")).toHaveText([
      "workgroups.md",
      "sessions.md",
      "boards.read",
    ]);
    await bootstrap.click();
    await page
      .locator(
        `[data-slot="project-header"][data-session-id="project-chat:${hash}"] [data-slot="project-label"]`,
      )
      .click();
    const card = page
      .locator('[data-slot="session-message"]')
      .filter({ hasText: "Investigation update" });
    await expect(card.getByRole("button", { name: "Investigation update" })).toBeVisible();
    await expect(card.getByRole("link", { name: "boards.read", exact: true })).toHaveCount(0);
    await card.getByRole("link", { name: "workgroups.md", exact: true }).click();
    await expect(page.getByText("Could not open file", { exact: true })).toBeVisible();
    await card.getByRole("link", { name: "workspace document", exact: true }).click();
    const preview = page.getByRole("dialog", { name: /reference\.md$/ });
    await expect(preview).toContainText("Useful document content.");
    await preview.getByRole("button", { name: "Exit fullscreen" }).click();
    await card.getByRole("link", { name: "Open conversation", exact: true }).click();
    await expect(page.getByText("Original diagram investigation", { exact: true })).toBeVisible();
    expect(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().every((window) => !window.isVisible()),
      ),
    ).toBe(true);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
