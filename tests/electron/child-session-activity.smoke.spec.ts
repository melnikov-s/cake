import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const repositoryRoot = resolve(import.meta.dirname, "../..");

function chunk(delta: object, finishReason: string | null = null) {
  return `data: ${JSON.stringify({
    id: "child-activity-fixture",
    object: "chat.completion.chunk",
    created: 0,
    model: "fixture-model",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;
}

test("background family children show running activity before being selected", async () => {
  test.setTimeout(60_000);
  const temporaryRoot = await mkdtemp(join(tmpdir(), "cake-child-activity-"));
  const userData = join(temporaryRoot, "user-data");
  const project = join(temporaryRoot, "project");
  const cakeHome = join(temporaryRoot, "cake-home");
  let childResponse: ServerResponse | undefined;
  let firstRequest = true;
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (data) => {
      body += data;
    });
    request.on("end", () => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      if (firstRequest) {
        firstRequest = false;
        response.end(
          chunk({
            tool_calls: [
              {
                index: 0,
                id: "create-background-child",
                type: "function",
                function: {
                  name: "cake",
                  arguments: JSON.stringify({
                    command: "sessions.create-child",
                    input: { title: "Background worker", initialPrompt: "Child activity fixture" },
                  }),
                },
              },
            ],
          }) +
            chunk({}, "tool_calls") +
            "data: [DONE]\n\n",
        );
      } else if (
        !JSON.parse(body).messages.some((message: { role: string }) => message.role === "tool")
      ) {
        childResponse = response;
        response.write(chunk({ content: "Working on the child assignment." }));
      } else {
        response.end(
          chunk({ content: "Child launched." }) + chunk({}, "stop") + "data: [DONE]\n\n",
        );
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  await Promise.all([
    mkdir(userData, { recursive: true }),
    mkdir(project, { recursive: true }),
    mkdir(join(cakeHome, "pi"), { recursive: true }),
    mkdir(join(cakeHome, "state"), { recursive: true }),
  ]);
  await writeFile(
    join(cakeHome, "pi", "models.json"),
    JSON.stringify({
      providers: {
        "activity-provider": {
          name: "Activity provider",
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          apiKey: "fixture",
          api: "openai-completions",
          models: [
            {
              id: "fixture-model",
              name: "Activity fixture",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 128000,
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
      recentProjectPaths: [project],
      draft: "",
      theme: "dark",
    }),
  );
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
      trustedProjectPaths: [project],
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
    await page.getByRole("button", { name: "Model configuration" }).click({ timeout: 20_000 });
    await page.getByLabel("Search presets and models").fill("Activity fixture");
    await page
      .getByRole("button", { name: /Activity fixture/ })
      .first()
      .click();
    await page.getByRole("button", { name: "Apply", exact: true }).click();
    const composer = page.getByRole("combobox", { name: "Message", exact: true });
    await composer.click();
    await expect(composer).toBeFocused();
    await page.keyboard.type("Launch a background worker");
    await expect(composer).toHaveValue("Launch a background worker");
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
    const parentId = await page
      .locator('[data-slot="session-pane"]')
      .getAttribute("data-session-id");
    await page.keyboard.press("Enter");
    await expect.poll(() => Boolean(childResponse)).toBe(true);
    const childRow = page
      .locator(`.session-item:not([data-session-id="${parentId}"])`)
      .filter({ hasText: "Background worker" });
    await expect(childRow).toHaveCount(1);
    await expect(childRow.locator('[aria-label="Running"]')).toBeVisible();
    await expect(page.locator('[data-slot="session-pane"]')).toHaveCount(1);
    await expect(page.locator('[data-slot="session-pane"]')).toHaveAttribute(
      "data-session-id",
      parentId!,
    );

    childResponse!.end(chunk({}, "stop") + "data: [DONE]\n\n");
    await expect(childRow.locator('[aria-label="Running"]')).toHaveCount(0);
  } finally {
    await application.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
