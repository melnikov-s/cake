import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { cakeWorkspaceSessionDirectory } from "../../src/services/pi/runtime/session-discovery";
import { windowState } from "../fixtures/window-state";

const repositoryRoot = resolve(import.meta.dirname, "../..");

test("canceling child reports retires their outbox entries and Stop stays stopped", async () => {
  test.setTimeout(60_000);
  const root = await mkdtemp(join(tmpdir(), "cake-child-report-queue-"));
  const userData = join(root, "user-data");
  const project = join(root, "project");
  const cakeHome = join(root, "cake-home");
  const sessions = cakeWorkspaceSessionDirectory(project, join(cakeHome, "pi", "sessions"));
  const journal = join(cakeHome, "state", "session-families.json");
  const parentId = "00000000-0000-4000-8000-000000000001";
  const children = Array.from(
    { length: 21 },
    (_, index) => `00000000-0000-4000-8000-${String(index + 2).padStart(12, "0")}`,
  );
  const timestamp = "2026-01-01T00:00:00.000Z";
  const responses: ServerResponse[] = [];
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.flushHeaders();
    responses.push(response);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No fixture address");
  await Promise.all([
    mkdir(userData, { recursive: true }),
    mkdir(project, { recursive: true }),
    mkdir(sessions, { recursive: true }),
    mkdir(join(cakeHome, "state"), { recursive: true }),
  ]);
  await writeFile(
    join(cakeHome, "pi", "models.json"),
    JSON.stringify({
      providers: {
        fixture: {
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          apiKey: "fixture",
          api: "openai-completions",
          models: [
            {
              id: "fixture",
              name: "Fixture",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 200_000,
              maxTokens: 1024,
            },
          ],
        },
      },
    }),
  );
  await writeFile(
    join(userData, "window-state.json"),
    windowState({ project, sessionId: parentId, theme: "dark" }),
  );
  await writeFile(
    join(cakeHome, "state", "application.json"),
    JSON.stringify({
      schemaVersion: 1,
      projects: [{ path: project, name: "Project", addedAt: timestamp, lastOpenedAt: timestamp }],
      trustedProjectPaths: [project],
    }),
  );
  for (const id of [parentId, ...children]) {
    await writeFile(
      join(sessions, `2026-01-01T00-00-00-000Z_${id}.jsonl`),
      [
        { type: "session", version: 3, id, timestamp, cwd: project },
        {
          type: "model_change",
          id: "model",
          parentId: null,
          timestamp,
          provider: "fixture",
          modelId: "fixture",
        },
        {
          type: "message",
          id: "user",
          parentId: "model",
          timestamp,
          message: { role: "user", content: "Ready for reports", timestamp: 0 },
        },
        {
          type: "session_info",
          id: "info",
          parentId: "user",
          timestamp,
          name: id === parentId ? "Parent" : `Child ${children.indexOf(id) + 1}`,
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
    );
  }
  await writeFile(
    journal,
    JSON.stringify({
      version: 7,
      data: {
        families: [
          {
            familyId: parentId,
            parentSessionId: parentId,
            projectPath: project,
            workingDirectory: project,
            createdAt: timestamp,
            children: children.map((id) => ({
              sessionId: id,
              parentSessionId: parentId,
              requestId: id,
              workingDirectory: project,
              createdAt: timestamp,
            })),
          },
        ],
        spawnedSessions: [],
        turns: children.map((id, index) => ({
          sessionId: id,
          senderSessionId: parentId,
          turnId: id,
          requestMessageId: id,
          threadId: id,
          reported: false,
          outcome: "complete",
          report: { outcome: "result", text: `Child report ${index + 1}` },
        })),
      },
    }),
  );
  const app = await electron.launch({
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
    const page = await app.firstWindow();
    await expect.poll(() => responses.length).toBe(1);
    const queue = page.getByRole("list", { name: "Queued prompts" });
    await expect(queue.getByRole("listitem")).toHaveCount(20);
    // Reports must scroll inside the queue rather than crowding out the conversation.
    for (const viewport of [
      { width: 1100, height: 900 },
      { width: 800, height: 600 },
    ]) {
      await page.setViewportSize(viewport);
      await expect
        .poll(() => queue.evaluate((element) => element.getBoundingClientRect().height))
        .toBeLessThanOrEqual(Math.min(240, viewport.height * 0.25));
      expect(await queue.evaluate((element) => element.scrollHeight)).toBeGreaterThan(
        await queue.evaluate((element) => element.clientHeight),
      );
      await expect(page.getByRole("combobox", { name: "Message", exact: true })).toBeInViewport();
    }
    await queue.hover();
    await page.mouse.wheel(0, 2000);
    await expect.poll(() => queue.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    await expect(queue.getByRole("listitem").last()).toBeInViewport();
    for (let report = 21; report >= 2; report--) {
      await page
        .getByRole("button", {
          name: new RegExp(`Cancel queued message:.*Child report ${report}\\b`, "s"),
        })
        .click();
      await expect(queue.getByRole("listitem")).toHaveCount(report - 2);
    }
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
    // A queue-only assertion would miss the retry. Check the persistent authority
    // that the real background worker uses, including the already-consumed report.
    await expect
      .poll(async () => JSON.parse(await readFile(journal, "utf8")).data.turns.length)
      .toBe(0);
    const composer = page.getByRole("combobox", { name: "Message", exact: true });
    await composer.click();
    await expect(composer).toBeFocused();
    await composer.pressSequentially("A deliberate new request");
    await expect(composer).toHaveValue("A deliberate new request");
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
    await composer.press("Enter");
    await expect.poll(() => responses.length).toBe(2);
    await expect(queue.getByRole("listitem")).toHaveCount(0);
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
  } finally {
    await app.close();
    for (const response of responses) response.destroy();
    await new Promise<void>((done) => server.close(() => done()));
    await rm(root, { recursive: true, force: true });
  }
});
