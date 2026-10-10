import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { cakeWorkspaceSessionDirectory } from "../../src/services/pi/runtime/session-discovery";
import { encodeCrossSessionMessage } from "../../src/services/pi/cross-session-message";

const repositoryRoot = resolve(import.meta.dirname, "../..");

test("reorders both lanes, cancels one item, hands off without an error, and links the sender", async () => {
  test.setTimeout(90_000);
  const root = await mkdtemp(join(tmpdir(), "cake-queued-messages-"));
  const userData = join(root, "user-data"),
    project = join(root, "project"),
    cakeHome = join(root, "cake-home");
  const sessionId = "queue-destination",
    sourceId = "queue-origin";
  const sessions = cakeWorkspaceSessionDirectory(project, join(cakeHome, "pi", "sessions"));
  const responses: ServerResponse[] = [];
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.flushHeaders();
    responses.push(response);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as AddressInfo).port;
  await Promise.all([
    mkdir(userData, { recursive: true }),
    mkdir(sessions, { recursive: true }),
    mkdir(join(cakeHome, "state"), { recursive: true }),
    mkdir(join(project, ".pi", "extensions"), { recursive: true }),
  ]);
  await writeFile(
    join(cakeHome, "pi", "models.json"),
    JSON.stringify({
      providers: {
        "queue-provider": {
          name: "Queue provider",
          baseUrl: `http://127.0.0.1:${port}/v1`,
          apiKey: "fixture",
          api: "openai-completions",
          models: [
            {
              id: "fixture-model",
              name: "Queue fixture",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 4096,
              maxTokens: 1024,
            },
          ],
        },
      },
    }),
  );
  await writeFile(
    join(userData, "window-state.json"),
    JSON.stringify({
      projectPath: project,
      selectedSessionId: sessionId,
      activeConversation: { kind: "project-session", workspacePath: project, sessionId },
      recentProjectPaths: [project],
      draft: "",
      theme: "dark",
    }),
  );
  const timestamp = new Date(0).toISOString();
  await writeFile(
    join(cakeHome, "state", "application.json"),
    JSON.stringify({
      schemaVersion: 1,
      projects: [{ path: project, name: "project", addedAt: timestamp, lastOpenedAt: timestamp }],
      trustedProjectPaths: [project],
    }),
  );
  for (const [id, title, text] of [
    [sessionId, "Queue destination", "Ready for queue testing."],
    [sourceId, "Origin session", "Origin transcript."],
  ]) {
    await writeFile(
      join(sessions, `1970-01-01T00-00-00-000Z_${id}.jsonl`),
      [
        { type: "session", version: 3, id, timestamp, cwd: project },
        {
          type: "message",
          id: "user-1",
          parentId: null,
          timestamp,
          message: {
            role: "user",
            content: [{ type: "text", text: "Initial request" }],
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
            content: [{ type: "text", text }],
            api: "openai-completions",
            provider: "queue-provider",
            model: "fixture-model",
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
        { type: "session_info", id: "info", parentId: "assistant-1", timestamp, name: title },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
    );
  }
  const agentMessage = encodeCrossSessionMessage("Agent follow-up", {
    version: 1,
    messageId: "f6debbbd-ced1-4a12-b0f7-fb60c292c623",
    threadId: "8358c2b7-bd3c-42ee-9fec-fcb726b66c18",
    sequence: 1,
    expectsResponse: false,
    sender: { sessionId: sourceId, kind: "project-session", title: "Origin session" },
  });
  await writeFile(
    join(project, ".pi", "extensions", "queue-fixture.ts"),
    `export default function(pi) { pi.registerCommand("fixture-agent", { description: "Queue the agent fixture", handler: async () => { pi.sendUserMessage(${JSON.stringify(agentMessage)}, { deliverAs: "followUp" }); } }); }`,
  );
  const app = await electron.launch({
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
    const page = await app.firstWindow();
    await expect(page.getByText("Ready for queue testing.")).toBeVisible({ timeout: 20_000 });
    const composer = page.getByRole("combobox", { name: "Message", exact: true });
    const send = async (text: string) => {
      await composer.click();
      await expect(composer).toBeFocused();
      await composer.pressSequentially(text);
      await expect(composer).toHaveValue(text);
      await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
      await composer.press("Enter");
      await expect(composer).toHaveValue("");
    };
    await send("Start current response");
    await expect.poll(() => responses.length).toBe(1);
    await send("First user");
    await send("/fixture-agent");
    await expect(
      page.getByRole("button", { name: "View queued message: Agent follow-up" }),
    ).toBeVisible();
    await send("Second user");
    const queue = page.getByRole("list", { name: "Queued prompts" });
    const labels = () =>
      queue.getByRole("button", { name: /^View queued message:/ }).allTextContents();
    await expect.poll(labels).toEqual(["First user", "Agent follow-up", "Second user"]);
    await page.getByRole("button", { name: "Move up: Agent follow-up" }).click();
    await expect.poll(labels).toEqual(["Agent follow-up", "First user", "Second user"]);
    await page.getByRole("button", { name: "View queued message: Agent follow-up" }).click();
    const dialog = page.getByRole("dialog", { name: "Origin session" });
    await expect(dialog.getByRole("link", { name: "Origin session" })).toHaveAttribute(
      "href",
      `cake://session/${sourceId}`,
    );
    await dialog.getByRole("button", { name: "Exit fullscreen Origin session" }).click();
    await page.getByRole("button", { name: "Send now as steering: First user" }).click();
    await page.getByRole("button", { name: "Send now as steering: Second user" }).click();
    await expect.poll(labels).toEqual(["First user", "Second user", "Agent follow-up"]);
    await page.getByRole("button", { name: "Move up: Second user" }).click();
    await expect.poll(labels).toEqual(["Second user", "First user", "Agent follow-up"]);
    await page.getByRole("button", { name: "Cancel steering: Second user" }).click();
    await expect.poll(labels).toEqual(["First user", "Agent follow-up"]);
    await send("Keep queued");
    await page.getByRole("button", { name: "Stop and send now: Agent follow-up" }).click();
    await expect.poll(() => responses.length).toBeGreaterThan(1);
    await expect(queue).toContainText("Keep queued");
    await expect(page.getByText("Model request failed", { exact: true })).toHaveCount(0);
    await expect(page.getByText(/Request.*aborted/)).toHaveCount(0);
    // Return to the still-held provenance card and follow the real session navigation link.
    await send("/fixture-agent");
    await page.getByRole("button", { name: "View queued message: Agent follow-up" }).click();
    await page
      .getByRole("dialog", { name: "Origin session" })
      .getByRole("link", { name: "Origin session" })
      .click();
    // Navigation may leave the transient reader open; close it before inspecting the destination.
    const exit = page.getByRole("button", { name: "Exit fullscreen Origin session" });
    if (await exit.isVisible()) await exit.click();
    await expect(page.getByText("Origin transcript.")).toBeVisible({ timeout: 15_000 });
  } finally {
    await app.close();
    for (const response of responses) response.destroy();
    await new Promise<void>((done) => server.close(() => done()));
    await rm(root, { recursive: true, force: true });
  }
});
