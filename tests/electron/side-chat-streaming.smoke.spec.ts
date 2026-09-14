import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test, type Locator } from "@playwright/test";
import { cakeWorkspaceSessionDirectory } from "../../src/services/pi/runtime/session-discovery";

const repositoryRoot = resolve(import.meta.dirname, "../..");

/** Fraction of `element` that lies inside `scroller`'s visible box, 0 when none. */
const visibleFraction = async (element: Locator, scroller: Locator) => {
  const view = await scroller.elementHandle();
  if (!view) throw new Error("Missing scroller");
  return element.evaluate((node, viewport) => {
    const box = node.getBoundingClientRect();
    const visible = viewport.getBoundingClientRect();
    if (box.height === 0) return 0;
    const top = Math.max(box.top, visible.top);
    const bottom = Math.min(box.bottom, visible.bottom);
    return Math.max(0, bottom - top) / box.height;
  }, view);
};

test("side chat keeps its transcript visible and its composer available while streaming", async () => {
  test.setTimeout(60_000);
  const temporaryRoot = await mkdtemp(join(tmpdir(), "cake-side-chat-streaming-"));
  const userData = join(temporaryRoot, "user-data");
  const project = join(temporaryRoot, "project");
  const cakeHome = join(temporaryRoot, "cake-home");
  const sessionId = "side-chat-streaming-session";
  const sessionDirectory = cakeWorkspaceSessionDirectory(project, join(cakeHome, "pi", "sessions"));
  const timestamp = new Date(0).toISOString();
  const responses: ServerResponse[] = [];
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.flushHeaders();
    responses.push(response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const sendText = (response: ServerResponse, content: string) => {
    response.write(
      `data: ${JSON.stringify({
        id: "stream-fixture",
        object: "chat.completion.chunk",
        created: 0,
        model: "fixture-model",
        choices: [{ index: 0, delta: { content }, finish_reason: null }],
      })}\n\n`,
    );
  };
  const finish = (response: ServerResponse) => {
    response.write(
      `data: ${JSON.stringify({
        id: "stream-fixture",
        object: "chat.completion.chunk",
        created: 0,
        model: "fixture-model",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      })}\n\ndata: [DONE]\n\n`,
    );
    response.end();
  };
  await Promise.all([
    mkdir(userData, { recursive: true }),
    mkdir(project, { recursive: true }),
    mkdir(sessionDirectory, { recursive: true }),
    mkdir(join(cakeHome, "state"), { recursive: true }),
  ]);
  await writeFile(
    join(cakeHome, "pi", "models.json"),
    JSON.stringify({
      providers: {
        "stream-provider": {
          name: "Stream provider",
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          apiKey: "fixture",
          api: "openai-completions",
          models: [
            {
              id: "fixture-model",
              name: "Stream fixture",
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
          content: [{ type: "text", text: "Show the settings shape" }],
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
          content: [{ type: "text", text: "The settings shape is explicit." }],
          api: "openai-completions",
          provider: "stream-provider",
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
    await expect(page.getByText("The settings shape is explicit.")).toBeVisible({
      timeout: 20_000,
    });
    const composer = page.getByRole("combobox", { name: "Message", exact: true });
    await composer.click();
    await expect(composer).toBeFocused();
    await page.keyboard.type("/sidechat Explain the settings shape in detail");
    await expect(composer).toHaveValue("/sidechat Explain the settings shape in detail");
    await page.keyboard.press("Enter");

    const sideChat = page.getByRole("complementary", { name: "Side chat" });
    await expect(sideChat).toBeVisible();
    const sideChatInput = sideChat.getByRole("combobox", { name: "Reply to side chat" });
    const streamedAnswer = sideChat.getByText("Side chat streamed answer", { exact: false });

    await expect.poll(() => responses.length).toBe(1);
    const sideChatResponse = responses[0]!;
    sendText(
      sideChatResponse,
      Array.from(
        { length: 12 },
        (_, index) => `Side chat streamed answer paragraph ${index}.\n\n`,
      ).join(""),
    );
    await expect(streamedAnswer.first()).toBeVisible();
    await expect(streamedAnswer.last()).toBeVisible();
    // The composer is part of the side chat like any other chat, even while it streams.
    await expect(sideChatInput).toBeVisible();
    await expect(sideChat.getByRole("button", { name: "Stop", exact: true })).toBeVisible();

    // Submitting while the side chat streams queues the prompt instead of being refused.
    await sideChatInput.click();
    await page.keyboard.type("And then what?");
    await expect(sideChatInput).toHaveValue("And then what?");
    await expect(sideChat.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
    await page.keyboard.press("Enter");
    const queued = sideChat.getByRole("list", { name: "Queued prompts" });
    await expect(queued).toContainText("And then what?");
    await expect(sideChatInput).toHaveValue("");

    finish(sideChatResponse);
    // The queued prompt starts the next turn once the first one settles.
    await expect.poll(() => responses.length, { timeout: 15_000 }).toBe(2);
    await expect(queued).toHaveCount(0);
    const followUpResponse = responses[1]!;
    sendText(followUpResponse, "Follow-up streamed answer.");
    await expect(sideChat.getByText("Follow-up streamed answer.")).toBeVisible();
    finish(followUpResponse);
    await expect(sideChat.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);

    // Settling the turn must not blank the transcript: the latest answer stays
    // in the side chat's viewport next to the composer.
    await expect(sideChatInput).toBeVisible();
    await expect(sideChat.getByText("Follow-up streamed answer.")).toBeVisible();
    const transcript = sideChat.locator(".transcript");
    await expect
      .poll(() => visibleFraction(sideChat.getByText("Follow-up streamed answer."), transcript))
      .toBeGreaterThan(0.9);
    await expect
      .poll(() =>
        transcript.evaluate(
          (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
        ),
      )
      .toBeLessThanOrEqual(1);
  } finally {
    for (const response of responses) response.end();
    await application.close();
    server.closeAllConnections();
    server.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
