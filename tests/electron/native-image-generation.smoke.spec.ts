import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import {
  imageProviderResponse,
  nativeImageScript,
  originalImageBytes,
} from "../fixtures/native-images";

const repositoryRoot = resolve(import.meta.dirname, "../..");

test("native images appear in Chat and only explicitly requested originals are saved", async () => {
  test.setTimeout(120_000);
  const temporaryRoot = await mkdtemp(join(tmpdir(), "cake-native-image-smoke-"));
  const userData = join(temporaryRoot, "user-data");
  const project = join(temporaryRoot, "project");
  const cakeHome = join(temporaryRoot, "cake-home");
  const images: unknown[] = [];
  const original = originalImageBytes();
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk.toString();
    const payload = JSON.parse(body);
    if (payload.modalities?.includes("image")) {
      images.push(payload);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(imageProviderResponse()));
      return;
    }
    const messages = payload.messages as { role: string; content?: unknown }[];
    const userIndex = messages.findLastIndex(
      (message) =>
        message.role === "user" && JSON.stringify(message.content)?.includes("Generate native"),
    );
    const prompt = JSON.stringify(messages[userIndex]?.content);
    const isGeneration =
      prompt?.includes("Generate native preview") || prompt?.includes("Generate native and save");
    const hasToolResult = messages.slice(userIndex + 1).some((message) => message.role === "tool");
    const save = prompt?.includes("Generate native and save");
    const toolCall = isGeneration && !hasToolResult;
    const delta = toolCall
      ? {
          tool_calls: [
            {
              index: 0,
              id: `image-${save ? "saved" : "preview"}`,
              type: "function",
              function: {
                name: "codemode",
                arguments: JSON.stringify({
                  code: nativeImageScript(
                    save ? { save: "fox.png", reference: "reference.png" } : {},
                  ),
                }),
              },
            },
          ],
        }
      : {
          content: isGeneration
            ? save
              ? "Original saved: [fox.png](fox.png)"
              : "Preview ready; no file saved."
            : "Native image fixture",
        };
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(
      [
        `data: ${JSON.stringify({ id: "fixture-chat", object: "chat.completion.chunk", model: "fixture-image-chat", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
        `data: ${JSON.stringify({ id: "fixture-chat", object: "chat.completion.chunk", model: "fixture-image-chat", choices: [{ index: 0, delta: {}, finish_reason: toolCall ? "tool_calls" : "stop" }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } })}\n\n`,
        "data: [DONE]\n\n",
      ].join(""),
    );
  });
  await new Promise<void>((complete) => server.listen(0, "127.0.0.1", complete));
  const address = server.address() as AddressInfo;
  await Promise.all([
    mkdir(userData, { recursive: true }),
    mkdir(join(project, ".pi"), { recursive: true }),
    mkdir(join(cakeHome, "pi"), { recursive: true }),
    mkdir(join(cakeHome, "state"), { recursive: true }),
  ]);
  await writeFile(join(project, "reference.png"), original);
  // Only change the external endpoint/auth. OpenRouter's builtin native images API is retained.
  await writeFile(
    join(cakeHome, "pi", "models.json"),
    JSON.stringify({
      providers: {
        openrouter: {
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          apiKey: "fixture-key",
          api: "openai-completions",
          models: [
            {
              id: "fixture-image-chat",
              name: "Fixture image chat",
              reasoning: false,
              input: ["text", "image"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 8192,
              maxTokens: 2048,
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
      theme: "system",
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
      PI_CODING_AGENT_DIR: join(cakeHome, "pi"),
      PI_CODING_AGENT_SESSION_DIR: "",
      PI_OFFLINE: "1",
      OPENROUTER_API_KEY: "",
    },
  });
  try {
    const page = await application.firstWindow();
    const composer = page.getByRole("combobox", { name: "Message", exact: true });
    await expect(composer).toBeVisible({ timeout: 20_000 });
    await page.getByRole("button", { name: "Model configuration" }).click();
    await page.getByLabel("Search presets and models").fill("Fixture image chat");
    await page
      .getByRole("button", { name: /Fixture image chat/ })
      .first()
      .click();
    await page.getByRole("button", { name: "Apply", exact: true }).click();
    await composer.click();
    await expect(composer).toBeFocused();
    await composer.pressSequentially("Generate native preview");
    await expect(composer).toHaveValue("Generate native preview");
    const send = page.getByRole("button", { name: "Send", exact: true });
    await expect(send).toBeEnabled();
    await send.click();
    await expect(page.getByText("Preview ready; no file saved.", { exact: true })).toBeVisible({
      timeout: 30_000,
    });
    expect(images).toHaveLength(1);
    expect(await readdir(project)).toEqual([".pi", "reference.png"]);
    const workLog = page.locator('[data-slot="activity-group"]').first();
    await expect(workLog).not.toHaveAttribute("open");
    const preview = page
      .getByRole("button", { name: /View Tool output image .* enlarged/ })
      .first();
    await expect(preview).toBeVisible({ timeout: 5_000 });
    await expect(
      page.getByRole("button", { name: /View Tool output image .* enlarged/ }),
    ).toHaveCount(1);
    expect(
      await preview.evaluate((element) => Boolean(element.closest('[data-slot="activity-group"]'))),
    ).toBe(false);
    await preview.click();
    const fullscreen = page.getByRole("dialog", { name: /Tool output image/ });
    await expect(fullscreen).toBeVisible();
    await expect(fullscreen.locator("img")).toHaveAttribute("src", /^data:image\/png;base64,/);
    await page.keyboard.press("Escape");
    await expect(fullscreen).toBeHidden();
    await expect(preview).toBeFocused();
    await workLog.locator("summary").click();
    await page.getByRole("button", { name: /^codemode/ }).click();
    await expect(page.getByText("Script", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("button", { name: /View Tool output image .* enlarged/ }),
    ).toHaveCount(1);
    await workLog.locator("summary").click();
    await expect(preview).toBeVisible();

    // Saved Pi results replay inline too, without another generation request.
    await page.reload();
    await expect(page.getByText("Preview ready; no file saved.", { exact: true })).toBeVisible();
    await expect(preview).toBeVisible();
    await expect(workLog).not.toHaveAttribute("open");
    expect(images).toHaveLength(1);

    await composer.click();
    await composer.pressSequentially("Generate native and save fox.png using reference.png");
    await expect(composer).toHaveValue("Generate native and save fox.png using reference.png");
    await expect(send).toBeEnabled();
    await send.click();
    await expect(page.getByRole("link", { name: "fox.png", exact: true })).toBeVisible({
      timeout: 30_000,
    });
    expect(await readFile(join(project, "fox.png"))).toEqual(original);
    expect(images).toHaveLength(2);
    await expect(
      page.getByRole("button", { name: /View Tool output image .* enlarged/ }),
    ).toHaveCount(2);
    expect(images[1]).toMatchObject({
      messages: [
        {
          content: [
            expect.any(Object),
            {
              type: "image_url",
              image_url: { url: `data:image/png;base64,${original.toString("base64")}` },
            },
          ],
        },
      ],
    });
  } finally {
    await application.close();
    server.closeAllConnections();
    await new Promise<void>((complete, reject) =>
      server.close((error) => (error ? reject(error) : complete())),
    );
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
