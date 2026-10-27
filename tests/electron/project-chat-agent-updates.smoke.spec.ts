import { createServer, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { defaultApplicationState } from "../../src/contracts/application/application-data";
import { installLocalModelHttpGuard } from "./main-harness";

function reply(response: ServerResponse, content: string | { name: string; arguments: object }) {
  const tool = typeof content !== "string";
  const delta = tool
    ? {
        tool_calls: [
          {
            index: 0,
            id: "fixture-call",
            type: "function",
            function: { name: content.name, arguments: JSON.stringify(content.arguments) },
          },
        ],
      }
    : { role: "assistant", content };
  const chunk = (value: object, finish_reason: string | null = null) =>
    `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 0, model: "fixture", choices: [{ index: 0, delta: value, finish_reason }] })}\n\n`;
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end(chunk(delta) + chunk({}, tool ? "tool_calls" : "stop") + "data: [DONE]\n\n");
}

for (const timing of ["next-user", "timer"] as const)
  test(`Project Chat attributes investigator progress and deferred reports through restart (${timing})`, async () => {
    test.setTimeout(120_000);
    const root = await mkdtemp(join(tmpdir(), "cake-agent-attribution-"));
    const project = join(root, "project");
    const cakeHome = join(root, "cake");
    const agentDir = join(cakeHome, "pi");
    const userData = join(root, "user-data");
    await Promise.all(
      [project, agentDir, join(cakeHome, "state"), userData].map((path) =>
        mkdir(path, { recursive: true }),
      ),
    );
    const finishWorker = Promise.withResolvers<void>();
    const progress = "## Investigation progress\n\n**Source located**\n\n- Checking transport.";
    const report =
      "## Investigation findings\n\n**Typed provenance fixes attribution.**\n\n```ts\nconst authoredBy = 'worker';\n```";
    const requests: string[] = [];
    let workerRequests = 0;
    let launched = false;
    const server = createServer(async (request, response) => {
      let body = "";
      for await (const part of request) body += part;
      const input = JSON.parse(body);
      const summary = /Compaction: (?:compress message|merge lines)/.test(
        JSON.stringify(
          input.messages.findLast((message: { role: string }) => message.role === "user")?.content,
        ),
      );
      if (summary) {
        reply(response, "talk: attribution fixture");
        return;
      }
      requests.push(body);
      if (body.includes("## Project investigation worker")) {
        workerRequests += 1;
        if (workerRequests === 1)
          reply(response, { name: "message_parent", arguments: { text: progress } });
        else {
          await finishWorker.promise;
          reply(response, report);
        }
      } else if (!launched) {
        launched = true;
        reply(response, {
          name: "cake",
          arguments: {
            command: "subagents.start",
            input: { projectPath: project, task: "Investigate attribution", continuation: "none" },
          },
        });
      } else reply(response, "Update processed.");
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No fixture server");
    const origin = `http://127.0.0.1:${address.port}`;
    await writeFile(
      join(agentDir, "models.json"),
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
                maxTokens: 4096,
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
          projects: [
            {
              path: project,
              name: "Attribution project",
              addedAt: new Date(0).toISOString(),
              lastOpenedAt: new Date(0).toISOString(),
            },
          ],
          trustedProjectPaths: [project],
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
          PI_CODING_AGENT_DIR: agentDir,
          PI_CODING_AGENT_SESSION_DIR: "",
        },
      });
    let app = await launch();
    try {
      await installLocalModelHttpGuard(app, origin);
      let page = await app.firstWindow();
      const openChat = () =>
        page.getByRole("button", { name: "Open Project Chat for project", exact: true }).click();
      await openChat();
      const submit = async (text: string) => {
        const composer = page.getByRole("combobox", { name: "Message Project Chat", exact: true });
        await composer.click();
        await expect(composer).toBeFocused();
        await composer.pressSequentially(text);
        await expect(composer).toHaveValue(text);
        await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
        await composer.press("Enter");
      };
      const card = (heading: string) =>
        page
          .locator('[data-slot="session-message"]')
          .filter({ has: page.getByRole("heading", { name: heading, exact: true }) });
      const verifyProgress = async () => {
        const update = card("Investigation progress");
        await expect(update).toHaveCount(1);
        await expect(update.getByRole("button", { name: /^Worker / })).toBeVisible();
        await expect(update.locator('[data-streamdown="strong"]')).toHaveText("Source located");
        await expect(update.getByRole("listitem")).toHaveText("Checking transport.");
        await expect(
          update.getByRole("link", { name: "Open conversation", exact: true }),
        ).toHaveAttribute("href", /^cake:\/\/subagent\//);
        await expect(update).not.toContainText("You");
        await expect(page.locator(".transcript")).not.toContainText("Reply through this subagent");
      };
      await submit("Investigate attribution");
      await verifyProgress();
      expect(requests.some((request) => request.includes("Reply through this subagent"))).toBe(
        true,
      );
      finishWorker.resolve();
      const familyPath = join(cakeHome, "state", "session-families.json");
      await expect
        .poll(async () => {
          try {
            return JSON.parse(await readFile(familyPath, "utf8")).data.deferredReferences?.length;
          } catch {
            return 0;
          }
        })
        .toBe(1);
      await expect(card("Investigation findings")).toHaveCount(0);
      await app.close();
      if (timing === "timer") {
        const state = JSON.parse(await readFile(familyPath, "utf8"));
        const recipientSessionId = state.data.deferredReferences[0].recipientSessionId;
        state.data.updateBatches = [
          {
            recipientSessionId,
            openedAt: new Date(Date.now() - 300_000).toISOString(),
            dueAt: new Date(0).toISOString(),
          },
        ];
        await writeFile(familyPath, JSON.stringify(state));
      }
      app = await launch();
      await installLocalModelHttpGuard(app, origin);
      page = await app.firstWindow();
      await openChat();
      if (timing === "next-user") await submit("My actual next question");
      const verifyReport = async () => {
        await verifyProgress();
        const update = card("Investigation findings");
        await expect(update).toHaveCount(1);
        await expect(update.getByRole("button", { name: /^Worker / })).toBeVisible();
        await expect(update.locator('[data-streamdown="strong"]')).toHaveText(
          "Typed provenance fixes attribution.",
        );
        await expect(update.locator("pre")).toContainText("const authoredBy = 'worker';");
        await expect(
          update.getByRole("link", { name: "Open conversation", exact: true }),
        ).toHaveAttribute("href", /^cake:\/\/subagent\/.*\?message=/);
        await expect(update).not.toContainText("You");
        await expect(page.locator(".transcript")).not.toContainText("Deferred reports/status refs");
        await expect(page.locator(".transcript")).not.toContainText("Cake batched updates");
        if (timing === "next-user")
          await expect(
            page
              .locator('[data-slot="message"]')
              .filter({ has: page.getByText("My actual next question", { exact: true }) })
              .locator('[data-slot="message-label"]'),
          ).toHaveText("You");
      };
      await verifyReport();
      expect(requests.some((request) => request.includes("Deferred reports/status refs"))).toBe(
        true,
      );
      await page.reload();
      await openChat();
      await verifyReport();
      await submit("Another genuine user message");
      await expect(
        page
          .locator('[data-slot="message"]')
          .filter({ has: page.getByText("Another genuine user message", { exact: true }) })
          .locator('[data-slot="message-label"]'),
      ).toHaveText("You");
      await expect(card("Investigation findings")).toHaveCount(1);
      expect(
        await app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().every((window) => !window.isVisible()),
        ),
      ).toBe(true);
    } finally {
      finishWorker.resolve();
      await app.close();
      await new Promise<void>((done) => server.close(() => done()));
      await rm(root, { recursive: true, force: true });
    }
  });
