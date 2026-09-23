import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const repositoryRoot = resolve(import.meta.dirname, "../..");

const interviewArguments = {
  command: "interview.open",
  input: {
    request: {
      protocol: "cake.request/v1",
      id: "fixture-interview",
      title: "Fixture interview",
      responseSchema: {
        type: "object",
        properties: { region: { type: "string" }, name: { type: "string" } },
      },
      view: {
        type: "form",
        fields: [
          {
            id: "region",
            label: "Region",
            type: "select",
            options: [
              { value: "us", label: "US" },
              { value: "eu", label: "EU" },
            ],
          },
          { id: "name", label: "Project name", type: "text" },
        ],
      },
      fallback: { markdown: "Choose a region and name." },
    },
  },
};

function streamChunks(response: ServerResponse, chunks: unknown[]) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const chunk of chunks) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
  response.end("data: [DONE]\n\n");
}

const chunk = (delta: unknown, finishReason: string | null = null) => ({
  id: "fixture",
  object: "chat.completion.chunk",
  created: 0,
  model: "fixture-model",
  choices: [{ index: 0, delta, finish_reason: finishReason }],
});

test("interview.open renders its stepped form and resolves the tool call", async () => {
  test.setTimeout(120_000);
  const temporaryRoot = await mkdtemp(join(tmpdir(), "cake-interview-open-smoke-"));
  const userData = join(temporaryRoot, "user-data");
  const project = join(temporaryRoot, "project");
  const cakeHome = join(temporaryRoot, "cake-home");
  await mkdir(userData, { recursive: true });
  await mkdir(project, { recursive: true });

  const toolResults: string[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (data: Buffer) => (body += data.toString()));
    request.on("end", () => {
      const messages = (JSON.parse(body) as { messages: Array<{ role: string; content: unknown }> })
        .messages;
      const toolMessage = messages.findLast((message) => message.role === "tool");
      if (!toolMessage)
        return streamChunks(response, [
          chunk({
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "call_interview",
                type: "function",
                function: { name: "cake", arguments: JSON.stringify(interviewArguments) },
              },
            ],
          }),
          chunk({}, "tool_calls"),
        ]);
      toolResults.push(
        typeof toolMessage.content === "string"
          ? toolMessage.content
          : JSON.stringify(toolMessage.content),
      );
      streamChunks(response, [
        chunk({ role: "assistant", content: "Interview received." }),
        chunk({}, "stop"),
      ]);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;

  // Pi's models.json registers the provider for every session, including drafts.
  await mkdir(join(cakeHome, "pi"), { recursive: true });
  await writeFile(
    join(cakeHome, "pi", "models.json"),
    JSON.stringify({
      providers: {
        "fixture-provider": {
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          apiKey: "fixture",
          api: "openai-completions",
          models: [
            {
              id: "fixture-model",
              name: "Fixture model",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 32_000,
              maxTokens: 1_024,
            },
          ],
        },
      },
    }),
  );
  await writeFile(
    join(userData, "window-state.json"),
    JSON.stringify({ projectPath: project, recentProjectPaths: [project], draft: "" }),
  );
  await mkdir(join(cakeHome, "state"), { recursive: true });
  await writeFile(
    join(cakeHome, "state", "application.json"),
    JSON.stringify({
      schemaVersion: 1,
      projects: [
        {
          path: project,
          name: "project",
          addedAt: new Date(0).toISOString(),
          lastOpenedAt: new Date(0).toISOString(),
        },
      ],
      trustedProjectPaths: [],
    }),
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
    await expect(page.getByLabel("Message")).toBeVisible({ timeout: 20_000 });

    await page.getByRole("button", { name: "Model configuration" }).click();
    // Without a configured default the picker opens directly on model search.
    const search = page.getByLabel("Search presets and models");
    const changeModel = page.getByRole("button", { name: /Change model/ });
    await expect(search.or(changeModel)).toBeVisible();
    if (await changeModel.isVisible()) await changeModel.click();
    await search.fill("Fixture model");
    await page
      .getByRole("button", { name: /Fixture model/ })
      .first()
      .click();
    await page.getByRole("button", { name: "Apply" }).click();
    await expect(page.getByLabel("Search presets and models")).toBeHidden();

    const composer = page.getByLabel("Message");
    await composer.fill("Interview me");
    await composer.press("Enter");

    const form = page.locator('[data-artifact-id="fixture-interview"]');
    await expect(form).toBeVisible({ timeout: 30_000 });
    await expect(form).toContainText("Question 1 of 2");
    await form.getByText("EU", { exact: true }).click();
    await form.getByRole("button", { name: "Next" }).click();
    await expect(form).toContainText("Question 2 of 2");
    const name = form.getByRole("textbox", { name: "Project name" });
    await expect(name).toBeFocused();
    await name.pressSequentially("Cake");
    await expect(name).toHaveValue("Cake");
    await name.press("Enter");
    await expect(form).toContainText("Review answers");
    expect(toolResults).toHaveLength(0);
    await form.getByRole("button", { name: "Submit" }).click();

    await expect(form).toContainText("Submitted");
    await expect(page.getByText("Interview received.")).toBeVisible({ timeout: 30_000 });
    expect(toolResults).toHaveLength(1);
    expect(JSON.parse(toolResults[0]!)).toEqual({
      artifactId: "fixture-interview",
      cancelled: false,
      value: { region: "eu", name: "Cake" },
    });
  } finally {
    await application.close();
    server.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
