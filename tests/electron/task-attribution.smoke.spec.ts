import { createServer, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { _electron as electron } from "../../scripts/queued-electron.mjs";
import { defaultApplicationState } from "../../src/contracts/application/application-data";
import { emptyProjectTodos } from "../../src/contracts/projects/project-todos";
import { windowState } from "../fixtures/window-state";

const repository = resolve(import.meta.dirname, "../..");
const A = "00000000-0000-4000-8000-000000000011";
const B = "00000000-0000-4000-8000-000000000012";
const chunk = (content: string, finish_reason: string | null = null) =>
  `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 0, model: "fixture", choices: [{ index: 0, delta: { content }, finish_reason }] })}\n\n`;

test("Project Chat clears stale attribution before streaming omitted or invalid metadata and supports switch, null and return", async () => {
  test.setTimeout(90_000);
  const root = await mkdtemp(join(tmpdir(), "cake-task-attribution-"));
  const project = join(root, "project");
  const cakeHome = join(root, "cake");
  const agentDir = join(cakeHome, "pi");
  const userData = join(root, "user-data");
  const requests: Array<{ response: ServerResponse; turnId: string }> = [];
  const server = createServer(async (request, response) => {
    const body = JSON.parse(Buffer.concat(await request.toArray()).toString()) as {
      messages: Array<{ role: string; content: string | Array<{ text?: string }> | null }>;
    };
    const content = body.messages.findLast((message) => message.role === "user")?.content;
    const text =
      typeof content === "string" ? content : (content?.map((part) => part.text).join("\n") ?? "");
    const turnId = [...text.matchAll(/cake-turn id="([^"]+)"/g)].at(-1)?.[1];
    if (!turnId) throw new Error("Expected a current human attribution token");
    expect(JSON.stringify(body)).toContain("For EVERY current human");
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.flushHeaders();
    requests.push({ response, turnId });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture address");
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    await Promise.all([
      mkdir(project),
      mkdir(agentDir, { recursive: true }),
      mkdir(join(cakeHome, "state"), { recursive: true }),
      mkdir(userData),
      mkdir(join(repository, ".visual-captures"), { recursive: true }),
    ]);
    await writeFile(
      join(agentDir, "models.json"),
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
    const presetId = "00000000-0000-4000-8000-000000000001";
    const timestamp = new Date(0).toISOString();
    await writeFile(
      join(cakeHome, "state", "application.json"),
      JSON.stringify({
        version: 7,
        data: {
          ...defaultApplicationState(),
          projects: [
            {
              path: project,
              name: "Attribution regression",
              addedAt: timestamp,
              lastOpenedAt: timestamp,
              todos: {
                ...emptyProjectTodos(),
                items: [A, B].map((id, index) => ({
                  id,
                  title: index === 0 ? "Startup investigation" : "Navigation improvements",
                  description: "Attribution regression",
                  status: "",
                  state: "open",
                  revision: 0,
                  associations: [],
                })),
              },
            },
          ],
          modelPresets: [
            {
              id: presetId,
              name: "Fixture",
              provider: "fixture",
              modelId: "fixture",
              thinkingLevel: "off",
              fastMode: false,
            },
          ],
          defaultModelPresetId: presetId,
        },
      }),
    );
    await writeFile(join(userData, "window-state.json"), windowState({ project, theme: "dark" }));
    app = await electron.launch({
      args: [repository],
      cwd: repository,
      env: {
        ...process.env,
        CAKE_ELECTRON_SMOKE: "1",
        CAKE_HOME: cakeHome,
        CAKE_ELECTRON_USER_DATA: userData,
        PI_CODING_AGENT_DIR: agentDir,
        PI_CODING_AGENT_SESSION_DIR: "",
      },
    });
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1600, height: 1100 });
    await page
      .getByRole("button", { name: "Open Project Chat for Attribution regression", exact: true })
      .click();
    const composer = page.getByRole("combobox", { name: "Message Project Chat", exact: true });
    const transcript = page.locator('[data-slot="content-transition-live"] .transcript').last();
    const row = (text: string) =>
      transcript
        .getByText(text, { exact: true })
        .locator('xpath=ancestor::*[@data-slot="transcript-item"]');
    const choices = [A, "missing", "invalid", B, null, A] as const;
    const topics = [
      "Investigate startup",
      "Different topic without metadata",
      "Another topic with invalid metadata",
      "Switch to navigation",
      "A question with no task",
      "Return to startup",
    ];
    for (const [index, choice] of choices.entries()) {
      const topic = topics[index]!;
      await composer.fill(topic);
      await composer.press("Enter");
      await expect.poll(() => requests.length).toBe(index + 1);
      const { response, turnId } = requests[index]!;
      // Pending human input cannot retain the preceding task, even before any provider text.
      await expect(row(topic).locator('[data-slot="margin-rail"]')).toHaveCount(0);
      const prefix =
        choice === "missing"
          ? ""
          : choice === "invalid"
            ? '<cake-todo>{"turnId":"invalid","todoId":null}</cake-todo>'
            : `<cake-todo>${JSON.stringify({ turnId, todoId: choice })}</cake-todo>`;
      const answer = `Answer ${index + 1}`;
      response.write(chunk(prefix + answer));
      await expect(transcript.getByText(answer, { exact: true })).toBeVisible();
      const assigned = choice === A || choice === B;
      if (assigned) {
        await expect(
          row(topic).getByRole("button", {
            name: `Show in To-do: ${choice === A ? "Startup investigation" : "Navigation improvements"}`,
            exact: true,
          }),
        ).toBeVisible();
      }
      for (const text of [topic, answer]) {
        await expect(row(text).locator('[data-slot="margin-rail"]')).toHaveCount(assigned ? 1 : 0);
      }
      if (choice === "missing") {
        // A late valid trailer must not relabel the already-streaming rows.
        response.write(chunk(`<cake-todo>${JSON.stringify({ turnId, todoId: A })}</cake-todo>`));
      }
      response.end(chunk("", "stop") + "data: [DONE]\n\n");
      await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();
      await expect(row(topic).locator('[data-slot="margin-rail"]')).toHaveCount(assigned ? 1 : 0);
      await expect(transcript).not.toContainText("cake-todo");
      if (index === 2 || index === choices.length - 1) {
        await page.waitForFunction(() => document.fonts.status === "loaded");
        await page.mouse.move(1, 1);
        await page.screenshot({
          animations: "disabled",
          path: join(
            repository,
            ".visual-captures",
            index === 2 ? "task-attribution-missing.png" : "task-attribution-return.png",
          ),
        });
      }
    }
    expect(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().every((window) => !window.isVisible()),
      ),
    ).toBe(true);
  } finally {
    for (const { response } of requests) response.end();
    await app?.close();
    await new Promise<void>((done) => server.close(() => done()));
    await rm(root, { recursive: true, force: true });
  }
});
