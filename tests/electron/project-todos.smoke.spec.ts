import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { defaultApplicationState } from "../../src/contracts/application/application-data";
import { emptyProjectTodos } from "../../src/contracts/projects/project-todos";
import { cakeWorkspaceSessionDirectory } from "../../src/services/pi/runtime/session-discovery";

const repository = resolve(import.meta.dirname, "../..");
type Request = { messages: Array<{ role: string; content: string | object[] | null }> };
const latestUser = (request: Request) =>
  JSON.stringify(request.messages.findLast((message) => message.role === "user")?.content);

test("Project Chat side pane, context, titled links and independent session lifecycle", async () => {
  test.setTimeout(90_000);
  const directory = await mkdtemp(join(tmpdir(), "cake-project-todos-"));
  const project = join(directory, "project");
  const cakeHome = join(directory, "cake");
  const userData = join(directory, "user-data");
  const requests: Request[] = [];
  const reviewId = "00000000-0000-4000-8000-000000000011";
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const input = JSON.parse(body) as Request;
    requests.push(input);
    const user = latestUser(input);
    const marker =
      /(?:CREATE_LINKED|RESOLVE_LINKED|LINK_SOURCE|INPUT_[A-Z_]+)/.exec(user)?.[0] ?? "request";
    const command =
      marker === "CREATE_LINKED"
        ? {
            command: "todos.create",
            input: {
              title: "Implement startup improvement",
              description: "Implement startup improvement.",
              status: "Working across two sessions",
              associations: [
                { kind: "session", sessionId: "linked-a", title: "First implementation" },
                { kind: "session", sessionId: "linked-b", title: "Second implementation" },
              ],
            },
          }
        : marker === "LINK_SOURCE"
          ? {
              command: "todos.update",
              input: {
                id: reviewId,
                expectedRevision: 0,
                associations: [
                  {
                    kind: "source",
                    ref: "cake://session/linked-a?message=report",
                    title: "Investigation report",
                  },
                ],
              },
            }
          : marker === "RESOLVE_LINKED"
            ? {
                command: "sessions.resolve",
                input: { targets: [{ kind: "project", sessionId: "linked-b" }], resolved: true },
              }
            : undefined;
    const tool = command && input.messages.at(-1)?.role === "user";
    const chunk = (delta: object, finish_reason: string | null) =>
      `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 0, model: "fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(
      tool
        ? chunk(
            {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: `call-${marker}`,
                  type: "function",
                  function: { name: "cake", arguments: JSON.stringify(command) },
                },
              ],
            },
            null,
          ) +
            chunk({}, "tool_calls") +
            "data: [DONE]\n\n"
        : chunk({ role: "assistant", content: `Finished ${marker}` }, null) +
            chunk({}, "stop") +
            "data: [DONE]\n\n",
    );
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture unavailable");
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    await Promise.all([
      mkdir(project),
      mkdir(join(cakeHome, "state"), { recursive: true }),
      mkdir(join(cakeHome, "pi"), { recursive: true }),
      mkdir(userData),
      mkdir(join(directory, "home")),
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
    const timestamp = "2026-01-01T00:00:00.000Z";
    const sessions = cakeWorkspaceSessionDirectory(project, join(cakeHome, "pi", "sessions"));
    await mkdir(sessions, { recursive: true });
    for (const [id, title] of [
      ["linked-a", "First implementation"],
      ["linked-b", "Second implementation"],
    ]) {
      await writeFile(
        join(sessions, `2026-01-01T00-00-00-000Z_${id}.jsonl`),
        [
          { type: "session", version: 3, id, timestamp, cwd: project },
          { type: "session_info", id: "name", parentId: null, timestamp, name: title },
          {
            type: "message",
            id: "question",
            parentId: "name",
            timestamp,
            message: { role: "user", content: [{ type: "text", text: "Implement" }], timestamp: 0 },
          },
          {
            type: "message",
            id: "report",
            parentId: "question",
            timestamp,
            message: {
              role: "assistant",
              content: [{ type: "text", text: "Implementation report" }],
              api: "openai-completions",
              provider: "fixture",
              model: "fixture",
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
        ]
          .map((entry) => JSON.stringify(entry))
          .join("\n") + "\n",
      );
    }
    const preset = "00000000-0000-4000-8000-000000000001";
    await writeFile(
      join(cakeHome, "state", "application.json"),
      JSON.stringify({
        version: 9,
        data: {
          ...defaultApplicationState(),
          projects: [
            {
              path: project,
              name: "Project",
              addedAt: timestamp,
              lastOpenedAt: timestamp,
              todos: {
                ...emptyProjectTodos(),
                items: [
                  {
                    id: reviewId,
                    title: "Review conversations",
                    description: "Review conversations.",
                    status: "Report delivered; awaiting your review",
                    state: "open",
                    revision: 0,
                    associations: [
                      {
                        kind: "source",
                        ref: "cake://session/linked-a?message=report",
                        title: "Investigation report",
                      },
                    ],
                  },
                ],
              },
            },
          ],
          trustedProjectPaths: [project],
          modelPresets: [
            {
              id: preset,
              name: "Fixture",
              provider: "fixture",
              modelId: "fixture",
              thinkingLevel: "off",
              fastMode: false,
            },
          ],
          defaultModelPresetId: preset,
          utilityModel: { provider: "fixture", modelId: "fixture", thinkingLevel: "off" },
        },
      }),
    );
    app = await electron.launch({
      args: [repository],
      cwd: repository,
      env: {
        ...process.env,
        HOME: join(directory, "home"),
        CAKE_ELECTRON_SMOKE: "1",
        CAKE_HOME: cakeHome,
        CAKE_ELECTRON_USER_DATA: userData,
        PI_CODING_AGENT_DIR: join(cakeHome, "pi"),
        PI_CODING_AGENT_SESSION_DIR: "",
      },
    });
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1500, height: 900 });
    await page.getByRole("button", { name: "Cake Chat", exact: true }).click();
    await page.locator('[data-slot="project-header"] [data-slot="project-label"]').first().click();
    const input = page.getByRole("combobox", { name: "Message Project Chat" });
    const send = async (text: string) => {
      await input.click();
      await expect(input).toBeFocused();
      await input.pressSequentially(text);
      await expect(input).toHaveValue(text);
      await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
      await input.press("Enter");
      await expect(page.getByText(`Finished ${text}`, { exact: true })).toBeVisible();
    };
    await send("CREATE_LINKED");
    expect(
      requests.at(-1)?.messages.findLast((message) => message.role === "tool")?.content,
    ).toContain("Implement startup improvement");
    await send("LINK_SOURCE");
    expect(
      requests.at(-1)?.messages.findLast((message) => message.role === "tool")?.content,
    ).toContain("cake://session/linked-a?message=report");
    const toggle = page.getByRole("button", { name: "To-do", exact: true });
    await expect(toggle).toHaveText("2");
    await expect(toggle.locator("svg")).toHaveAttribute("aria-hidden", "true");
    await toggle.hover();
    await expect(page.getByRole("tooltip", { name: "To-do", exact: true })).toBeVisible();
    await input.hover();
    await expect(page.getByRole("tooltip", { name: "To-do", exact: true })).toBeHidden();
    await toggle.focus();
    await expect(toggle).toBeFocused();
    await toggle.press("Enter");
    const panel = page.getByRole("complementary", { name: "To-do", exact: true });
    await expect(panel).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await toggle.focus();
    await toggle.press("Space");
    await expect(panel).toBeHidden();
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await toggle.focus();
    await toggle.press("Space");
    await expect(panel).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    const layout = page.locator('[data-slot="side-chat-layout"]');
    await expect(layout).toHaveAttribute("data-presentation", "side-by-side");
    await expect(
      panel.getByRole("button", { name: "Implement startup improvement", exact: true }),
    ).toBeVisible();
    await expect(panel.getByRole("link", { name: "First implementation" })).toHaveAttribute(
      "href",
      "cake://session/linked-a",
    );
    await expect(panel.getByRole("link", { name: "Investigation report" })).toHaveAttribute(
      "href",
      "cake://session/linked-a?message=report",
    );
    const separator = page.getByRole("separator", { name: "Resize side chat" });
    const width = Number(await separator.getAttribute("aria-valuenow"));
    await separator.focus();
    await separator.press("ArrowLeft");
    await expect(separator).toHaveAttribute("aria-valuenow", String(width + 16));
    await panel.getByRole("button", { name: "Review conversations", exact: true }).click();
    await expect(
      panel.getByRole("button", { name: "Review conversations", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: "Close To-do" }).click();
    await expect(input).toBeFocused();
    await send("INPUT_SELECTED");
    const selected = requests.find((request) => latestUser(request).includes("INPUT_SELECTED"));
    expect(selected && latestUser(selected)).toContain("Project Chat user changes");
    expect(selected && latestUser(selected)).toContain(reviewId);
    await send("INPUT_UNCHANGED");
    const unchanged = requests.find((request) => latestUser(request).includes("INPUT_UNCHANGED"));
    expect(unchanged && latestUser(unchanged)).not.toContain("Project Chat user changes");
    await toggle.click();
    await page.setViewportSize({ width: 780, height: 800 });
    await expect(layout).toHaveAttribute("data-presentation", "replacement");
    await expect(panel).toBeVisible();
    await expect(input).not.toBeVisible();
    await page.getByRole("button", { name: "Close To-do" }).click();
    await expect(input).toBeVisible();
    await expect(input).toBeFocused();
    await page.setViewportSize({ width: 1500, height: 900 });
    await toggle.click();
    await panel.getByRole("button", { name: "Mark done: Review conversations" }).click();
    await expect(toggle).toHaveText("1");
    await panel.getByRole("button", { name: "Done (1)" }).click();
    await panel.getByRole("button", { name: "Reopen: Review conversations" }).click();
    await expect(toggle).toHaveText("2");
    await expect(
      panel
        .getByRole("list", { name: "Open to-dos" })
        .getByText("Review conversations", { exact: true }),
    ).toBeVisible();
    const first = page.locator('.session-item[data-session-id="linked-a"]');
    await first.hover();
    await first.getByRole("button", { name: "Resolve First implementation" }).click();
    await expect(
      panel.getByRole("button", { name: "Implement startup improvement", exact: true }),
    ).toBeVisible(); // second session still open
    await page.getByRole("button", { name: "Close To-do" }).click();
    await send("RESOLVE_LINKED");
    await toggle.click();
    await expect(
      panel.getByRole("button", { name: "Mark done: Implement startup improvement" }),
    ).toBeVisible();
    await expect(
      panel.getByRole("button", { name: "Review conversations", exact: true }),
    ).toBeVisible(); // source report is NOT resolution
    const persisted = JSON.parse(
      await readFile(join(cakeHome, "state", "application.json"), "utf8"),
    );
    const changes = persisted.data.projects[0].todos.pending;
    // Only the actual user transition is a user delta, not the agent's second resolution.
    expect(changes.filter((change: { _tag: string }) => change._tag === "SessionState")).toEqual(
      [],
    ); // consumed on RESOLVE_LINKED
    const resolveRequest = requests.find((request) =>
      latestUser(request).includes("RESOLVE_LINKED"),
    );
    expect(resolveRequest && latestUser(resolveRequest)).toContain("First implementation");
    expect(resolveRequest && latestUser(resolveRequest)).toContain("SessionState");
    await panel.getByRole("link", { name: "Investigation report" }).click();
    await expect(page.getByText("Implementation report", { exact: true })).toBeVisible();
  } finally {
    await app?.close();
    await new Promise<void>((done) => server.close(() => done()));
    await rm(directory, { recursive: true, force: true });
  }
});
