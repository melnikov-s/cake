import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { defaultApplicationState } from "../../src/contracts/application/application-data";
import { CAKE_CHAT_SESSION_ID } from "../../src/contracts/cake-chats/cake-chat-identity";
import { installLocalModelHttpGuard } from "./main-harness";

type ModelRequest = { messages: Array<{ role: string; content: unknown }> };
const chunk = (delta: object, finish_reason: string | null = null) =>
  `data: ${JSON.stringify({ id: "handoff", object: "chat.completion.chunk", created: 0, model: "fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;

for (const timing of ["next-user", "timer"] as const)
  test(`global Cake Chat handoffs retain readable sender Markdown across first open/restart (${timing})`, async () => {
    test.setTimeout(120_000);
    // Retain the isolated profile: no registered project or session is deleted by this test.
    const root = await mkdtemp(join(tmpdir(), "cake-project-handoff-"));
    console.log(`Retained handoff fixture: ${root}`);
    const cakeHome = join(root, "cake");
    const userData = join(root, "user-data");
    const passiveProject = join(root, "passive-project");
    const promptProject = join(root, "prompt-project");
    await Promise.all(
      [cakeHome, userData, passiveProject, promptProject].map((path) =>
        mkdir(path, { recursive: true }),
      ),
    );
    for (const project of [passiveProject, promptProject])
      execFileSync("git", ["init", "--quiet", project]);
    await mkdir(join(cakeHome, "state"));
    await mkdir(join(cakeHome, "pi"));
    const requests: ModelRequest[] = [];
    const receipts: Array<Record<string, unknown>> = [];
    const ids = new Map<string, string>();
    const steps = new Map<string, number>();
    const server = createServer(async (request, response) => {
      let body = "";
      for await (const part of request) body += part;
      const parsed: ModelRequest = JSON.parse(body);
      const lastUser = JSON.stringify(
        parsed.messages.findLast((message) => message.role === "user")?.content,
      );
      const summary = /Compaction: (?:compress message|merge lines)/.test(lastUser);
      if (!summary) requests.push(parsed);
      const latest = parsed.messages.at(-1);
      if (!summary && latest?.role === "tool") {
        const result = JSON.parse(String(latest.content));
        receipts.push(result);
        if (result.project?.projectChatId) {
          ids.set(result.project.path, result.project.projectChatId);
        }
      }
      const passiveFlow = lastUser.includes("Run passive fixture");
      const promptFlow = lastUser.includes("Run prompt fixture");
      const reopenFlow = lastUser.includes("Reopen passive fixture");
      let invocation: { command: string; input: object } | undefined;
      if (!summary && (passiveFlow || promptFlow || reopenFlow)) {
        const flow = passiveFlow ? "passive" : promptFlow ? "prompt" : "reopen";
        const step = steps.get(flow) ?? 0;
        steps.set(flow, step + 1);
        const project = promptFlow ? promptProject : passiveProject;
        const sessionId = ids.get(project);
        if (!reopenFlow && step === 0)
          invocation = { command: "projects.add", input: { path: project } };
        else if (!reopenFlow && step === 1)
          invocation = {
            command: "sessions.send",
            input: {
              sessionId,
              text: promptFlow
                ? "IMMEDIATE_HANDOFF"
                : "## Project vision\n\n**PASSIVE_HANDOFF**\n\n- Discuss before building.",
              delivery: promptFlow ? "prompt" : "fyi",
              resultDelivery: "ignore",
            },
          };
        else if (
          (!reopenFlow && step === 2 && (!passiveFlow || timing === "next-user")) ||
          (reopenFlow && step === 0)
        )
          invocation = { command: "sessions.open", input: { sessionId } };
      }
      const text = summary
        ? "talk: fixture handoff"
        : passiveFlow
          ? `Passive receipt retained. [Passive project](cake://session/${encodeURIComponent(ids.get(passiveProject) ?? "")})`
          : promptFlow
            ? `Immediate receipt admitted. [Prompt project](cake://session/${encodeURIComponent(ids.get(promptProject) ?? "")})`
            : reopenFlow
              ? "Reopened passive fixture."
              : lastUser.includes("IMMEDIATE_HANDOFF")
                ? "Immediate handoff processed."
                : "Retained handoff processed.";
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        chunk(
          invocation
            ? {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: `handoff-${requests.length}`,
                    type: "function",
                    function: { name: "cake", arguments: JSON.stringify(invocation) },
                  },
                ],
              }
            : { role: "assistant", content: text },
        ) +
          chunk({}, invocation ? "tool_calls" : "stop") +
          "data: [DONE]\n\n",
      );
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No fixture server");
    const origin = `http://127.0.0.1:${address.port}`;
    await writeFile(
      join(cakeHome, "pi", "models.json"),
      JSON.stringify({
        providers: {
          fixture: {
            baseUrl: `${origin}/v1`,
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
    await writeFile(
      join(cakeHome, "state", "application.json"),
      JSON.stringify({
        version: 7,
        data: {
          ...defaultApplicationState(),
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
          utilityModel: { provider: "fixture", modelId: "fixture", thinkingLevel: "off" },
        },
      }),
    );
    const repository = resolve(import.meta.dirname, "../..");
    const launch = () =>
      electron.launch({
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
    let app = await launch();
    try {
      await installLocalModelHttpGuard(app, origin);
      let page = await app.firstWindow();
      const submit = async (label: string, text: string) => {
        const input = page.getByRole("combobox", { name: label, exact: true });
        await input.click();
        await expect(input).toBeFocused();
        await input.pressSequentially(text);
        await expect(input).toHaveValue(text);
        await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
        await input.press("Enter");
      };
      const selected = () => page.locator('[data-slot="session-pane"]');
      await page.getByRole("button", { name: "Cake Chat", exact: true }).first().click();
      await submit("Message Cake Chat", "Run passive fixture");
      if (timing === "next-user")
        await expect
          .poll(() => receipts.filter((receipt) => receipt.command === "sessions.open").length)
          .toBe(1);
      else
        await expect(
          page.getByRole("link", { name: "Passive project", exact: true }),
        ).toBeVisible();
      const initialOpens = timing === "next-user" ? 1 : 0;
      expect(receipts.filter((receipt) => receipt.command === "sessions.open")).toHaveLength(
        initialOpens,
      );
      const passiveId = ids.get(passiveProject) ?? "";
      expect(passiveId).toMatch(/^project-chat:[a-f0-9]{64}$/);
      expect(receipts.find((receipt) => receipt.command === "sessions.send")).toMatchObject({
        ok: true,
        status: "deferred",
        transcriptDelivery: "pending",
        execution: "not-requested",
        expectsResponse: false,
        target: { sessionId: passiveId, workspacePath: passiveProject },
      });
      if (timing === "next-user") {
        expect(receipts.find((receipt) => receipt.command === "sessions.open")).toMatchObject({
          ok: true,
          opened: { sessionId: passiveId, workspacePath: passiveProject },
        });
        await expect(selected()).toHaveAttribute("data-session-id", passiveId);
        await expect(page.getByRole("combobox", { name: "Message Project Chat" })).toBeVisible();
      }
      await expect(
        page.getByRole("button", { name: "Cake · passive updates", exact: true }),
      ).toHaveCount(0);
      // Only the global model ran; opening alone neither drains the FYI nor starts the recipient.
      expect(requests).toHaveLength(timing === "next-user" ? 4 : 3);
      await app.close();
      if (timing === "timer") {
        // Seed an expired durable deadline while the isolated backend is stopped.
        // Normal five-minute timing remains covered by TestClock domain tests.
        const path = join(cakeHome, "state", "session-families.json");
        const state = JSON.parse(await readFile(path, "utf8"));
        state.data.updateBatches = [
          {
            recipientSessionId: passiveId,
            openedAt: new Date(Date.now() - 300_000).toISOString(),
            dueAt: new Date(0).toISOString(),
          },
        ];
        await writeFile(path, JSON.stringify(state));
      }
      app = await launch();
      await installLocalModelHttpGuard(app, origin);
      page = await app.firstWindow();
      if (timing === "next-user") {
        await expect(selected()).toHaveAttribute("data-session-id", passiveId, { timeout: 20_000 });
        await expect(page.locator('[data-slot="session-message"]')).toHaveCount(0);
        await submit("Message Project Chat", "Read retained handoff");
      } else {
        // The recipient has never been opened; the ordinary scheduler drains the expired batch.
        await expect
          .poll(() =>
            requests.some((request) => {
              const user = JSON.stringify(
                request.messages.findLast((message) => message.role === "user")?.content,
              );
              return user.includes("Cake batched updates") && user.includes("PASSIVE_HANDOFF");
            }),
          )
          .toBe(true);
        await page.getByRole("link", { name: "Passive project", exact: true }).click();
        await expect(selected()).toHaveAttribute("data-session-id", passiveId);
      }
      await expect(page.getByText("Retained handoff processed.", { exact: true })).toBeVisible();
      const handoff = () =>
        page
          .locator('[data-slot="session-message"]')
          .filter({ has: page.getByRole("heading", { name: "Project vision", exact: true }) });
      const verifyHandoff = async () => {
        await expect(handoff()).toHaveCount(1);
        await expect(
          handoff().getByRole("button", { name: "Cake Chat", exact: true }),
        ).toHaveAttribute("aria-expanded", "true");
        await expect(
          handoff().getByRole("link", { name: "Open conversation", exact: true }),
        ).toBeVisible();
        await expect(handoff().locator('[data-streamdown="strong"]')).toHaveText("PASSIVE_HANDOFF");
        await expect(handoff().getByRole("listitem")).toHaveText("Discuss before building.");
        await expect(handoff()).not.toContainText("You");
        await expect(page.locator(".transcript")).not.toContainText("Cake batched updates");
        await expect(
          page.getByRole("button", { name: "Cake · passive updates", exact: true }),
        ).toHaveCount(0);
      };
      await verifyHandoff();
      await expect
        .poll(async () => await readFile(join(userData, "window-state.json"), "utf8"))
        .toContain(passiveId);
      await page.reload();
      await page
        .getByRole("button", { name: "Open Project Chat for passive-project", exact: true })
        .click();
      await verifyHandoff();
      const deliveredRequest = requests.at(-1);
      expect(JSON.stringify(deliveredRequest)).toContain(CAKE_CHAT_SESSION_ID);
      expect(JSON.stringify(deliveredRequest)).toContain('\\"senderTitle\\":\\"Cake Chat\\"');
      expect(JSON.stringify(deliveredRequest)).toContain("PASSIVE_HANDOFF");
      await submit("Message Project Chat", "Another user message");
      await verifyHandoff();
      await page.getByRole("button", { name: "Cake Chat", exact: true }).first().click();
      await expect(page.getByRole("link", { name: "Passive project", exact: true })).toBeVisible();
      // Exercise the actual encoded canonical deep link, independently of sessions.open.
      await page.getByRole("link", { name: "Passive project", exact: true }).click();
      await expect(selected()).toHaveAttribute("data-session-id", passiveId);
      await page.getByRole("button", { name: "Cake Chat", exact: true }).first().click();
      await submit("Message Cake Chat", "Run prompt fixture");
      await expect
        .poll(() => receipts.filter((receipt) => receipt.command === "sessions.open").length)
        .toBe(initialOpens + 1);
      const promptId = ids.get(promptProject) ?? "";
      expect(promptId).toMatch(/^project-chat:[a-f0-9]{64}$/);
      expect(
        receipts.filter((receipt) => receipt.command === "sessions.send").at(-1),
      ).toMatchObject({
        ok: true,
        status: "accepted",
        transcriptDelivery: "unverified",
        execution: "unverified",
        target: { sessionId: promptId },
      });
      await expect(selected()).toHaveAttribute("data-session-id", promptId);
      await expect(page.locator(".transcript")).toContainText("IMMEDIATE_HANDOFF");
      await expect(page.getByText("Immediate handoff processed.", { exact: true })).toBeVisible();
      await expect(page.locator(".transcript")).not.toContainText("PASSIVE_HANDOFF");
      await page.getByRole("button", { name: "Cake Chat", exact: true }).first().click();
      await submit("Message Cake Chat", "Reopen passive fixture");
      await expect(selected()).toHaveAttribute("data-session-id", passiveId);
      await verifyHandoff();
      await expect(page.locator(".transcript")).not.toContainText("IMMEDIATE_HANDOFF");
      expect(
        await app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().every((window) => !window.isVisible()),
        ),
      ).toBe(true);
      const persisted = JSON.parse(
        await readFile(join(cakeHome, "state", "application.json"), "utf8"),
      );
      expect(
        persisted.data.projects.map((project: { path: string }) => project.path).sort(),
      ).toEqual([passiveProject, promptProject].sort());
    } finally {
      await app.close();
      await new Promise<void>((done) => server.close(() => done()));
    }
  });
