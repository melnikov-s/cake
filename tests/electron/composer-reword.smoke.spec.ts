import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { callRpcHarness, openRpcHarness } from "./rpc-harness";

const repositoryRoot = resolve(import.meta.dirname, "../..");

function completion(text: string) {
  const chunk = (delta: Record<string, string>, finishReason: string | null) =>
    `data: ${JSON.stringify({
      id: "fixture-completion",
      object: "chat.completion.chunk",
      created: 0,
      model: "reword-model",
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    })}\n\n`;
  return `${chunk({ role: "assistant", content: text }, null)}${chunk({}, "stop")}data: [DONE]\n\n`;
}

test("rewords composer text and opens the focused session assistant", async () => {
  test.setTimeout(60_000);
  const temporaryRoot = await mkdtemp(join(tmpdir(), "cake-composer-reword-smoke-"));
  const userData = join(temporaryRoot, "user-data");
  const project = join(temporaryRoot, "project");
  const cakeHome = join(temporaryRoot, "cake-home");
  const piAgent = join(cakeHome, "pi");
  await Promise.all([
    mkdir(userData, { recursive: true }),
    mkdir(project, { recursive: true }),
    mkdir(piAgent, { recursive: true }),
  ]);

  const prompts: string[] = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    prompts.push(body);
    const rewritten = body.includes("compact session assistant")
      ? "Assistant ready"
      : body.includes("Make this terse")
        ? "Terse request"
        : "Clear request";
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(completion(rewritten));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  // SAFETY: the server is listening on a TCP host and ephemeral port above.
  const address = server.address() as AddressInfo;

  await writeFile(
    join(piAgent, "models.json"),
    JSON.stringify({
      providers: {
        "reword-provider": {
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          api: "openai-completions",
          apiKey: "fixture",
          models: [
            {
              id: "reword-model",
              name: "Reword model",
              reasoning: false,
              input: ["text"],
              contextWindow: 16_000,
              maxTokens: 8_192,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
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
      trustedProjectPaths: [project],
      utilityModel: {
        provider: "reword-provider",
        modelId: "reword-model",
        thinkingLevel: "off",
      },
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
    const composer = page.getByLabel("Message");
    await expect(composer).toBeVisible({ timeout: 20_000 });
    await composer.fill("Before rough ramble after");
    await composer.evaluate((input: HTMLTextAreaElement) => input.setSelectionRange(7, 19));

    const harness = await openRpcHarness(application, "composer-reword");
    const rewritten = await callRpcHarness<{ text: string }>(harness, "invokeNative", {
      type: "reword-composer-selection",
      selection: "rough ramble",
    });
    expect(rewritten).toEqual({ text: "Clear request" });
    await composer.evaluate((input: HTMLTextAreaElement, text: string) => {
      input.focus();
      input.setSelectionRange(7, 19);
      document.execCommand("insertText", false, text);
    }, rewritten.text);

    await expect(composer).toHaveValue("Before Clear request after");
    await expect(composer).toBeFocused();
    await composer.press(process.platform === "darwin" ? "Meta+z" : "Control+z");
    await expect(composer).toHaveValue("Before rough ramble after");
    await composer.press("End");
    await composer.pressSequentially("!");
    await expect(composer).toHaveValue("Before rough ramble after!");
    await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();

    const assistantTrigger = page.getByRole("button", { name: "Ask session assistant" });
    await assistantTrigger.click();
    const quickAssistant = page.getByRole("dialog", { name: "Quick session assistant" });
    const quickInput = quickAssistant.getByLabel("Ask session assistant");
    await expect(quickInput).toBeFocused();
    const triggerBox = (await assistantTrigger.boundingBox())!;
    const quickInputBox = (await quickAssistant.boundingBox())!;
    expect(
      Math.abs(quickInputBox.x + quickInputBox.width / 2 - (triggerBox.x + triggerBox.width / 2)),
    ).toBeLessThan(2);
    expect(quickInputBox.y + quickInputBox.height).toBeLessThan(triggerBox.y);
    await quickInput.pressSequentially("Open the file from our conversation");
    await expect(quickInput).toHaveValue("Open the file from our conversation");
    const assistantSend = quickAssistant.getByRole("button", { name: "Send" });
    await expect(assistantSend).toBeEnabled();
    await assistantSend.click();
    await expect(quickAssistant.getByText("Assistant ready")).toBeVisible();
    await expect(quickAssistant.getByText("Open the file from our conversation")).toHaveCount(0);
    await expect(
      quickAssistant.getByRole("button", { name: "View response fullscreen" }),
    ).toHaveCount(0);
    const responseBox = (await quickAssistant.boundingBox())!;
    expect(responseBox.x + responseBox.width).toBeLessThan(triggerBox.x);
    expect(prompts).toHaveLength(2);

    await expect(quickAssistant).toHaveCount(0, { timeout: 6_000 });
    await assistantTrigger.click({ button: "right" });
    const fullAssistant = page.getByRole("dialog", { name: "Session assistant chat" });
    const fullInput = fullAssistant.getByLabel("Message session assistant");
    await expect(fullInput).toBeFocused();
    await expect(fullAssistant.getByText("Open the file from our conversation")).toBeVisible();
    await expect(fullAssistant.getByText("Assistant ready")).toBeVisible();
    await fullInput.fill("What did I just ask?");
    await fullAssistant.getByRole("button", { name: "Send" }).click();
    await expect.poll(() => prompts.length).toBe(3);
    expect(prompts.at(-1)).toContain("Open the file from our conversation");
  } finally {
    await application.close();
    server.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
