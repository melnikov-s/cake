import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "../../scripts/queued-electron.mjs";
import { expect, test } from "@playwright/test";
import { defaultApplicationState } from "../../src/contracts/application/application-data";
import { emptyProjectTodos } from "../../src/contracts/projects/project-todos";
import { cakeWorkspaceSessionDirectory } from "../../src/services/pi/runtime/session-discovery";
import { openProjectChat, showTodos } from "./fixtures/workspace-navigation";

const repository = resolve(import.meta.dirname, "../..");
type Request = { messages: Array<{ role: string; content: string | object[] | null }> };
const latestUser = (request: Request) =>
  JSON.stringify(request.messages.findLast((message) => message.role === "user")?.content);

test("Project Chat side pane, context, titled links and tool-resolved linked work closure", async () => {
  test.setTimeout(90_000);
  const directory = await mkdtemp(join(tmpdir(), "cake-project-todos-"));
  const project = join(directory, "project");
  const cakeHome = join(directory, "cake");
  const userData = join(directory, "user-data");
  const requests: Request[] = [];
  let releaseWork: (() => void) | undefined;
  const reviewId = "00000000-0000-4000-8000-000000000011";
  const standaloneTodoId = "038a885a-659d-46fb-8630-73b8701c1793";
  const standaloneSessionId = "00000000-0000-4000-8000-000025fa8baa";
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const input = JSON.parse(body) as Request;
    const utility =
      body.includes("Order these open to-dos") ||
      body.includes("Latest update from the new report");
    if (!utility) requests.push(input);
    const user = latestUser(input);
    const marker = utility
      ? "utility"
      : (user.match(/(?:CREATE_LINKED|RESOLVE_LINKED|LINK_SOURCE|INPUT_[A-Z_]+)/g)?.at(-1) ??
        "request");
    if (marker === "INPUT_HOLD")
      await new Promise<void>((done) => {
        releaseWork = done;
      });
    const command =
      marker === "CREATE_LINKED"
        ? {
            command: "todos.create",
            input: {
              title: "Implement startup improvement",
              description: "Implement startup improvement.",
              status: "Working across two sessions",
              // A Project Session belongs to one to-do (c4a6973c); the second implementation
              // stays with Compaction follow-up.
              associations: [
                { kind: "session", sessionId: "linked-a", title: "First implementation" },
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
                // Agents pass exact session IDs, not shortened references.
                input: {
                  targets: [{ kind: "project", sessionId: standaloneSessionId }],
                  resolved: true,
                },
              }
            : undefined;
    const tool = command && input.messages.at(-1)?.role === "user";
    const chunk = (delta: object, finish_reason: string | null) =>
      `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 0, model: "fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
    response.writeHead(200, { "content-type": "text/event-stream" });
    if (utility) {
      const content = input.messages.findLast((message) => message.role === "user")?.content;
      const raw =
        typeof content === "string"
          ? content
          : (content?.map((part) => ("text" in part ? part.text : "")).join("") ?? "");
      const contextMatch = /<context>\n([\s\S]*?)\n<\/context>/.exec(raw);
      if (!contextMatch) throw new Error("Utility request lacks its context envelope");
      const context = JSON.parse(contextMatch[1]!);
      const result = Array.isArray(context)
        ? JSON.stringify(context.map((item: { id: string }) => item.id))
        : context.currentDescription;
      response.end(
        chunk({ role: "assistant", content: result }, null) +
          chunk({}, "stop") +
          "data: [DONE]\n\n",
      );
      return;
    }
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
      [standaloneSessionId, "Second implementation"],
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
                    id: standaloneTodoId,
                    title: "Compaction follow-up",
                    description: "Finish the childless compaction session.",
                    status: "Landed; awaiting session resolution",
                    state: "open",
                    revision: 1,
                    associations: [
                      {
                        kind: "session",
                        sessionId: standaloneSessionId,
                        title: "Second implementation",
                      },
                    ],
                  },
                  {
                    id: reviewId,
                    title: "Review conversations",
                    description: "Report delivered; awaiting your review",
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
    // Chat-first navigation (582d0fc7): the Project Chat opens from the rail and its to-dos live
    // in the Workspace accessory's To-dos tab.
    await openProjectChat(page, "Project");
    const input = page.getByRole("combobox", { name: "Message Project Chat" });
    // Utility requests (titles, to-do updates) may follow the turn; read the last tool result.
    const latestToolResult = () =>
      requests.findLast((request) => request.messages.at(-1)?.role === "tool")?.messages.at(-1)
        ?.content;
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
    expect(latestToolResult()).toContain('"committed": true');
    await send("LINK_SOURCE");
    // The seeded row already carries this exact link, so the update commits without a new
    // revision.
    expect(latestToolResult()).toContain('"committed": true');
    expect(latestToolResult()).toContain('"revision": 0');
    const panel = await showTodos(page);
    const toggle = panel.getByRole("button", { name: /^To-dos\b/ });
    await expect(toggle).toHaveAccessibleName("To-dos 3");
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    // Links sit behind each row's link disclosure (50e4459e).
    const linked = panel
      .locator("[data-todo-id]")
      .filter({ has: page.getByRole("button", { name: "Implement startup improvement" }) });
    await linked
      .getByRole("button", { name: "Show 1 link for Implement startup improvement" })
      .click();
    await expect(linked.getByRole("link", { name: "First implementation" })).toHaveAttribute(
      "href",
      "cake://session/linked-a",
    );
    const review = panel.locator(`[data-todo-id="${reviewId}"]`);
    await review.getByRole("button", { name: "Show 1 link for Review conversations" }).click();
    await expect(review.getByRole("link", { name: "Investigation report" })).toHaveAttribute(
      "href",
      "cake://session/linked-a?message=report",
    );
    // Focus is a view filter in row actions (3977f22d): it neither sends nor attaches context.
    const requestsBeforeSelection = requests.length;
    const reviewFocus = review.getByRole("button", {
      name: "Focus to-do: Review conversations",
      exact: true,
    });
    await review.hover();
    await reviewFocus.click();
    await expect(reviewFocus).toHaveAttribute("aria-pressed", "true");
    await expect(
      page.locator('[data-slot="context-pill"]').filter({ hasText: "To-do ·" }),
    ).toHaveCount(0);
    expect(requests.length).toBe(requestsBeforeSelection);
    await reviewFocus.click();
    await expect(reviewFocus).toHaveAttribute("aria-pressed", "false");
    await reviewFocus.click();
    await expect(reviewFocus).toHaveAttribute("aria-pressed", "true");
    // Sending leaves this view filter intact and does not attach it as context. The focused
    // view filters the transcript to the focused to-do's turns, so read the request instead.
    await input.click();
    await input.pressSequentially("INPUT_SELECTED");
    await input.press("Enter");
    await expect(input).toHaveValue("");
    await expect
      .poll(() => requests.some((request) => latestUser(request).includes("INPUT_SELECTED")))
      .toBe(true);
    await expect(reviewFocus).toHaveAttribute("aria-pressed", "true");
    expect(
      latestUser(requests.findLast((request) => latestUser(request).includes("INPUT_SELECTED"))!),
    ).not.toContain("To-do · Review conversations");
    await review.hover();
    await review.getByRole("button", { name: "Unfocus to-do: Review conversations" }).click();
    await expect(reviewFocus).toHaveAttribute("aria-pressed", "false");
    // Completion and reopening move the row between sections and update the tab count.
    await review.hover();
    await review.getByRole("button", { name: "Mark done: Review conversations" }).click();
    await expect(toggle).toHaveAccessibleName("To-dos 2");
    await panel.getByRole("button", { name: "Done (1)" }).click();
    await panel.getByRole("button", { name: "Reopen: Review conversations" }).click();
    await expect(toggle).toHaveAccessibleName("To-dos 3");
    await expect(review).toHaveAttribute("data-todo-section", "Active");
    // A linked session opens from its work link; its live work shows on the link row.
    await linked.getByRole("link", { name: "First implementation", exact: true }).click();
    const sessionInput = page.getByRole("combobox", { name: "Message", exact: true });
    await expect(sessionInput).toBeVisible();
    await sessionInput.fill("INPUT_READY");
    await sessionInput.press("Enter");
    await expect(page.getByText("Finished INPUT_READY", { exact: true })).toBeVisible();
    const returnToTodos = async () => {
      await openProjectChat(page, "Project");
      await expect(input).toBeVisible();
      await showTodos(page);
    };
    await returnToTodos();
    const linkActivity = (name: string) =>
      linked
        .getByRole("listitem")
        .filter({ has: page.getByRole("link", { name: "First implementation", exact: true }) })
        .getByRole("img", { name });
    await expect(linkActivity("Ready for review")).toBeVisible();
    await linked.getByRole("link", { name: "First implementation", exact: true }).click();
    await sessionInput.fill("INPUT_HOLD");
    await sessionInput.press("Enter");
    await returnToTodos();
    await expect(linkActivity("Running")).toBeVisible();
    await expect(linked.getByRole("img", { name: "Running", exact: true }).first()).toBeVisible();
    await expect.poll(() => Boolean(releaseWork)).toBe(true);
    releaseWork!();
    await expect(linkActivity("Ready for review")).toBeVisible();
    // The agent resolves the second session through its tool; linked work closes only when
    // every required session resolves.
    const beforeToolResolve = JSON.parse(
      await readFile(join(cakeHome, "state", "application.json"), "utf8"),
    ).data.projects[0].todos.sequence;
    await send("RESOLVE_LINKED");
    const resolveReceipt = latestToolResult();
    expect(resolveReceipt).toContain('"resolved": true');
    expect(resolveReceipt).toContain('"sessionCount": 1');
    const done = panel.getByRole("button", { name: "Done (1)" });
    await expect(done).toBeVisible();
    if ((await done.getAttribute("aria-expanded")) !== "true") await done.click();
    await expect(panel.getByRole("button", { name: "Reopen: Compaction follow-up" })).toBeVisible();
    // First implementation is still open, so the linked to-do stays open.
    await expect(linked).toHaveAttribute("data-todo-section", "Active");
    const persisted = JSON.parse(
      await readFile(join(cakeHome, "state", "application.json"), "utf8"),
    );
    const committedTodos = persisted.data.projects[0].todos;
    expect(
      committedTodos.items.find((item: { id: string }) => item.id === standaloneTodoId),
    ).toMatchObject({ state: "done", revision: 2 });
    expect(committedTodos.sequence).toBeGreaterThan(beforeToolResolve);
    expect(committedTodos.selectedId ?? null).toBeNull();
    expect(
      committedTodos.items.filter((item: { state: string }) => item.state === "open"),
    ).toHaveLength(2);
    const changes = committedTodos.pending;
    // Tool resolution advances the same durable context as UI resolution, without a wake.
    expect(changes.filter((change: { _tag: string }) => change._tag === "SessionState")).toEqual([
      expect.objectContaining({ sessionId: standaloneSessionId, resolved: true }),
    ]);
    // Earlier human completion/reopening reaches the agent as a user-change reminder.
    const resolveRequest = requests.find((request) =>
      latestUser(request).includes("RESOLVE_LINKED"),
    );
    expect(resolveRequest && latestUser(resolveRequest)).toContain("Project Chat user changes");
    await review.getByRole("link", { name: "Investigation report" }).click();
    await expect(page.getByText("Implementation report", { exact: true })).toBeVisible();
    // To-do lifecycle state is reconstructed after reload without another model turn.
    const requestsBeforeReload = requests.length;
    await page.reload();
    await returnToTodos();
    const restoredDone = panel.getByRole("button", { name: "Done (1)" });
    if ((await restoredDone.getAttribute("aria-expanded")) !== "true") await restoredDone.click();
    await expect(panel.getByRole("button", { name: "Reopen: Compaction follow-up" })).toBeVisible();
    await expect(
      panel.getByRole("button", { name: "Focus to-do: Implement startup improvement" }),
    ).toHaveAttribute("aria-pressed", "false");
    expect(requests.length).toBe(requestsBeforeReload);
  } finally {
    releaseWork?.();
    await app?.close();
    await new Promise<void>((done) => server.close(() => done()));
    await rm(directory, { recursive: true, force: true });
  }
});
