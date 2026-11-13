import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "../../scripts/queued-electron.mjs";
import { expect, test } from "@playwright/test";
import { windowState } from "../fixtures/window-state";
import { defaultApplicationState } from "../../src/contracts/application/application-data";
import { emptyProjectTodos } from "../../src/contracts/projects/project-todos";

const repository = resolve(import.meta.dirname, "../..");

test("My session descendants stay together and mixed to-do session links retain individual relationship cues", async ({}, testInfo) => {
  const root = await mkdtemp(join(tmpdir(), "cake-session-purposes-"));
  const project = join(root, "project");
  const cakeHome = join(root, "cake-home");
  const userData = join(root, "user-data");
  const mine = "00000000-0000-4000-8000-000000000001";
  const delegated = "00000000-0000-4000-8000-000000000002";
  const child = "00000000-0000-4000-8000-000000000003";
  const grandchild = "00000000-0000-4000-8000-000000000004";
  const state = join(cakeHome, "state");
  const sessionDirectory = join(
    cakeHome,
    "pi",
    "sessions",
    `--${project.replace(/^\//, "").replaceAll("/", "-")}--`,
  );
  await Promise.all([
    mkdir(project, { recursive: true }),
    mkdir(state, { recursive: true }),
    mkdir(userData, { recursive: true }),
    mkdir(sessionDirectory, { recursive: true }),
  ]);
  const todos = emptyProjectTodos();
  todos.items.push({
    id: "00000000-0000-4000-8000-000000000010",
    title: "Explore and implement the same outcome",
    description: "Direct design and delegated implementation share one outcome.",
    status: "",
    state: "open",
    revision: 0,
    associations: [
      { kind: "session", sessionId: delegated, title: "Implementation assignment" },
      { kind: "session", sessionId: mine, title: "Design with me" },
    ],
  });
  await Promise.all([
    writeFile(
      join(userData, "window-state.json"),
      windowState({ project, sessionId: mine, theme: "light" }),
    ),
    writeFile(
      join(state, "application.json"),
      JSON.stringify({
        version: 7,
        data: {
          ...defaultApplicationState(),
          projects: [
            {
              path: project,
              name: "project",
              addedAt: new Date(0).toISOString(),
              lastOpenedAt: new Date(0).toISOString(),
              todos,
            },
          ],
        },
      }),
    ),
    writeFile(
      join(state, "session-families.json"),
      JSON.stringify({
        version: 12,
        data: {
          families: [
            {
              familyId: "my-family",
              parentSessionId: mine,
              projectPath: project,
              workingDirectory: project,
              createdAt: new Date(0).toISOString(),
              children: [
                { sessionId: child, parentSessionId: mine },
                { sessionId: grandchild, parentSessionId: child },
              ].map((member, index) => ({
                ...member,
                requestId: `child-${index}`,
                workingDirectory: project,
                createdAt: new Date(0).toISOString(),
              })),
            },
          ],
          turns: [],
          spawnedSessions: [],
          sessionPurposes: [
            { sessionId: mine, projectPath: project, purpose: "user", createdPurpose: "user" },
            ...[child, grandchild].map((sessionId) => ({
              sessionId,
              projectPath: project,
              purpose: "delegated",
              createdPurpose: "delegated",
            })),
            {
              sessionId: delegated,
              projectPath: project,
              purpose: "delegated",
              createdPurpose: "delegated",
            },
          ],
        },
      }),
    ),
    ...[
      [mine, "Design with me", "2026-01-01"],
      [child, "Investigate options", "2026-01-02"],
      [grandchild, "Check the details", "2026-01-03"],
      [delegated, "Implementation assignment", "2026-02-01"],
    ].map(async ([id, title, date]) => {
      const timestamp = `${date}T00:00:00.000Z`;
      const entries = [
        { type: "session", version: 3, id, timestamp, cwd: project },
        { type: "session_info", id: "title", parentId: null, timestamp, name: title },
        {
          type: "message",
          id: "context",
          parentId: "title",
          timestamp,
          message: {
            role: "user",
            content: "Discuss the design here before deciding what to implement.",
            timestamp: 0,
          },
        },
        {
          type: "message",
          id: "answer",
          parentId: "context",
          timestamp,
          message: {
            role: "assistant",
            content: [
              {
                type: "text",
                text: `We can keep designing in [our session](cake://session/${mine}) and inspect [delegated work](cake://session/${delegated}) without replacing either conversation.`,
              },
            ],
            api: "anthropic-messages",
            provider: "anthropic",
            model: "visual-fixture",
            stopReason: "stop",
            timestamp: 1,
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
          },
        },
      ];
      await writeFile(
        join(sessionDirectory, `${date}T00-00-00-000Z_${id}.jsonl`),
        entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
      );
    }),
  ]);
  const app = await electron.launch({
    args: [repository],
    cwd: repository,
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
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Open Project Chat for project", exact: true }).click();
    await page.getByRole("button", { name: /^Sessions ·/ }).click();
    const conversations = page.getByLabel("Session conversations", { exact: true });
    await expect(conversations.getByRole("heading", { name: "My sessions" })).toBeVisible();
    await expect(conversations.getByRole("heading", { name: "Delegated" })).toBeVisible();
    const rows = conversations.locator('[data-slot="conversation-navigator-row"][data-session-id]');
    await expect(rows).toHaveCount(5);
    const myGroup = conversations.getByRole("region", { name: "My sessions", exact: true });
    const delegatedGroup = conversations.getByRole("region", { name: "Delegated", exact: true });
    await expect(
      myGroup.locator(`[data-slot="conversation-navigator-row"][data-session-id="${child}"]`),
    ).toBeVisible();
    await expect(
      myGroup.locator(`[data-slot="conversation-navigator-row"][data-session-id="${grandchild}"]`),
    ).toBeVisible();
    await expect(
      delegatedGroup.locator('[data-slot="conversation-navigator-row"][data-session-id]'),
    ).toHaveCount(1);
    await expect(
      delegatedGroup.locator(
        `[data-slot="conversation-navigator-row"][data-session-id="${delegated}"]`,
      ),
    ).toBeVisible();
    expect(
      (
        await rows.evaluateAll((elements) =>
          elements.map((element) => element.getAttribute("data-session-id")),
        )
      ).slice(-4),
    ).toEqual([mine, child, grandchild, delegated]);
    await conversations
      .locator(`[data-session-id="${mine}"]`)
      .getByText("Design with me", { exact: true })
      .click();
    await expect(page.getByRole("link", { name: "User Session our session" })).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Delegated Session delegated work" }),
    ).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("session-order-and-links.png") });
    await page.getByRole("button", { name: /^To-dos/ }).click();
    const todo = page.locator('[data-todo-id="00000000-0000-4000-8000-000000000010"]');
    await expect(todo.getByRole("img", { name: "User Session" })).toBeVisible();
    await expect(todo.getByRole("img", { name: "Delegated Session" })).toBeVisible();
    expect(await todo.getByRole("link").allTextContents()).toEqual([
      "Implementation assignment",
      "Design with me",
    ]);
    await page.screenshot({ path: testInfo.outputPath("mixed-todo-session-links.png") });
    expect(
      JSON.parse(await readFile(join(state, "session-families.json"), "utf8")).data.sessionPurposes,
    ).toHaveLength(4);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
