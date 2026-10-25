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

test("global Cake Chat registers fresh projects, retains FYIs across open/restart and delivers immediate prompts", async () => {
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
            text: promptFlow ? "IMMEDIATE_HANDOFF" : "PASSIVE_HANDOFF",
            delivery: promptFlow ? "prompt" : "fyi",
            resultDelivery: "ignore",
          },
        };
      else if ((!reopenFlow && step === 2) || (reopenFlow && step === 0))
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
    await page.getByRole("button", { name: "Cake Chat", exact: true }).click();
    await submit("Message Cake Chat", "Run passive fixture");
    await expect
      .poll(() => receipts.filter((receipt) => receipt.command === "sessions.open").length)
      .toBe(1);
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
    expect(receipts.find((receipt) => receipt.command === "sessions.open")).toMatchObject({
      ok: true,
      opened: { sessionId: passiveId, workspacePath: passiveProject },
    });
    await expect(selected()).toHaveAttribute("data-session-id", passiveId);
    await expect(page.getByRole("combobox", { name: "Message Project Chat" })).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Cake · passive updates", exact: true }),
    ).toHaveCount(0);
    // Only the global model ran; opening alone neither drains the FYI nor starts the recipient.
    expect(requests).toHaveLength(4);
    await app.close();
    app = await launch();
    await installLocalModelHttpGuard(app, origin);
    page = await app.firstWindow();
    await expect(selected()).toHaveAttribute("data-session-id", passiveId, { timeout: 20_000 });
    await expect(
      page.getByRole("button", { name: "Cake · passive updates", exact: true }),
    ).toHaveCount(0);
    await submit("Message Project Chat", "Read retained handoff");
    await expect(page.getByText("Retained handoff processed.", { exact: true })).toBeVisible();
    const passivePill = () =>
      page.getByRole("button", { name: "Cake · passive updates", exact: true });
    await expect(passivePill()).toHaveCount(1);
    await passivePill().click();
    await expect(page.locator(".transcript")).toContainText("PASSIVE_HANDOFF");
    const deliveredRequest = requests.at(-1);
    expect(JSON.stringify(deliveredRequest)).toContain(CAKE_CHAT_SESSION_ID);
    expect(JSON.stringify(deliveredRequest)).toContain('\\"senderTitle\\":\\"Cake Chat\\"');
    expect(JSON.stringify(deliveredRequest)).toContain("PASSIVE_HANDOFF");
    await submit("Message Project Chat", "Another user message");
    await expect(passivePill()).toHaveCount(1);
    await page.getByRole("button", { name: "Cake Chat", exact: true }).click();
    await expect(page.getByRole("link", { name: "Passive project", exact: true })).toBeVisible();
    // Exercise the actual encoded canonical deep link, independently of sessions.open.
    await page.getByRole("link", { name: "Passive project", exact: true }).click();
    await expect(selected()).toHaveAttribute("data-session-id", passiveId);
    await page.getByRole("button", { name: "Cake Chat", exact: true }).click();
    await submit("Message Cake Chat", "Run prompt fixture");
    await expect
      .poll(() => receipts.filter((receipt) => receipt.command === "sessions.open").length)
      .toBe(2);
    const promptId = ids.get(promptProject) ?? "";
    expect(promptId).toMatch(/^project-chat:[a-f0-9]{64}$/);
    expect(receipts.filter((receipt) => receipt.command === "sessions.send").at(-1)).toMatchObject({
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
    await page.getByRole("button", { name: "Cake Chat", exact: true }).click();
    await submit("Message Cake Chat", "Reopen passive fixture");
    await expect(selected()).toHaveAttribute("data-session-id", passiveId);
    await expect(passivePill()).toHaveCount(1);
    await expect(page.locator(".transcript")).not.toContainText("IMMEDIATE_HANDOFF");
    expect(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().every((window) => !window.isVisible()),
      ),
    ).toBe(true);
    const persisted = JSON.parse(
      await readFile(join(cakeHome, "state", "application.json"), "utf8"),
    );
    expect(persisted.data.projects.map((project: { path: string }) => project.path).sort()).toEqual(
      [passiveProject, promptProject].sort(),
    );
  } finally {
    await app.close();
    await new Promise<void>((done) => server.close(() => done()));
  }
});
