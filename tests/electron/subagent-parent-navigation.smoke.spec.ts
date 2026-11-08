import { createServer, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { _electron as electron } from "../../scripts/queued-electron.mjs";
import { defaultApplicationState } from "../../src/contracts/application/application-data";

function reply(response: ServerResponse, content: string | { name: string; arguments: object }) {
  const tool = typeof content !== "string";
  const delta = tool
    ? {
        tool_calls: [
          {
            index: 0,
            id: "worker-launch",
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

test("global activity and tool inspection can return home through Back, breadcrumb, rail and session menu while preserving drafts", async () => {
  test.setTimeout(90_000);
  const temporary = await mkdtemp(join(tmpdir(), "cake-worker-navigation-"));
  const cakeHome = join(temporary, "cake-home");
  const agentDirectory = join(cakeHome, "pi");
  const userData = join(temporary, "user-data");
  await Promise.all([
    mkdir(agentDirectory, { recursive: true }),
    mkdir(join(cakeHome, "state"), { recursive: true }),
    mkdir(userData),
  ]);
  const gate = Promise.withResolvers<void>();
  let requests = 0;
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    if (body.includes("You are a hidden general researcher for Cake Chat.")) {
      await gate.promise;
      reply(response, "Worker finished.");
    } else if (++requests === 1) {
      reply(response, {
        name: "cake",
        arguments: { command: "subagents.start", input: { task: "Inspect navigation boundary" } },
      });
    } else reply(response, "Parent ready.");
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture address");
  await writeFile(
    join(agentDirectory, "models.json"),
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
  const app = await electron.launch({
    args: [resolve(import.meta.dirname, "../..")],
    env: {
      ...process.env,
      CAKE_ELECTRON_SMOKE: "1",
      CAKE_HOME: cakeHome,
      CAKE_ELECTRON_USER_DATA: userData,
      PI_CODING_AGENT_DIR: agentDirectory,
      PI_CODING_AGENT_SESSION_DIR: "",
    },
  });
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Open Cake Chat", exact: true }).click();
    const parent = page.getByRole("combobox", { name: "Message Cake Chat", exact: true });
    await parent.fill("Delegate navigation inspection");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByText("Parent ready.", { exact: true })).toBeVisible();
    await parent.click();
    await parent.pressSequentially("Retained parent draft");
    await expect(parent).toBeFocused();
    const activity = page.getByRole("button", { name: "Activity · 1 running", exact: true });
    const inspect = async () => {
      await activity.click();
      await page
        .getByRole("button", { name: "Inspect subagent: Inspect navigation boundary", exact: true })
        .click();
      await expect(page.getByRole("region", { name: "Subagent", exact: true })).toBeVisible();
      await expect(
        page
          .getByRole("navigation", { name: "Conversation breadcrumb" })
          .getByRole("button", { name: "Inspect navigation boundary", exact: true }),
      ).toHaveAttribute("aria-current", "page");
    };
    const assertParent = async () => {
      await expect(page.getByRole("region", { name: "Subagent", exact: true })).toHaveCount(0);
      await expect(parent).toBeVisible();
      await expect(parent).toHaveValue("Retained parent draft");
      await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
    };
    await inspect();
    const worker = page.getByRole("combobox", { name: "Message subagent", exact: true });
    await worker.click();
    await worker.pressSequentially("Retained worker draft");
    await expect(worker).toBeFocused();
    await expect(worker).toHaveValue("Retained worker draft");
    await page.getByRole("button", { name: "Back to source conversation", exact: true }).click();
    await assertParent();
    for (const entry of ["breadcrumb", "rail", "menu"] as const) {
      await inspect();
      await expect(worker).toHaveValue("Retained worker draft");
      if (entry === "breadcrumb")
        await page
          .getByRole("navigation", { name: "Conversation breadcrumb" })
          .getByRole("button", { name: "Cake Chat", exact: true })
          .click();
      else if (entry === "rail")
        await page.getByRole("button", { name: "Open Cake Chat", exact: true }).click();
      else {
        await page.getByRole("button", { name: "New session", exact: true }).click();
        await page
          .getByRole("dialog", { name: "New session" })
          .getByRole("option", { name: /Cake Chat/ })
          .click();
      }
      await assertParent();
    }
    const tool = page.getByRole("button", { name: "Open subagent chat", exact: true });
    if (!(await tool.isVisible()))
      await page
        .locator('[data-slot="activity-group"]')
        .first()
        .locator(":scope > summary")
        .click();
    await tool.click();
    await expect(
      page.getByRole("button", { name: "Back to source conversation", exact: true }),
    ).toBeVisible();
    await expect(worker).toHaveValue("Retained worker draft");
    await page.getByRole("button", { name: "Back to source conversation", exact: true }).click();
    await assertParent();
    const windows = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().map((window) => ({
        visible: window.isVisible(),
        focused: window.isFocused(),
      })),
    );
    expect(windows.every((window) => !window.visible && !window.focused)).toBe(true);
  } finally {
    gate.resolve();
    await app.close();
    await new Promise<void>((done) => server.close(() => done()));
    await rm(temporary, { recursive: true, force: true });
  }
});
