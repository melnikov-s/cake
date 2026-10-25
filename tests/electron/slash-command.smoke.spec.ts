import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { installLocalModelHttpGuard } from "./main-harness";
import { windowState } from "../fixtures/window-state";

const repositoryRoot = resolve(import.meta.dirname, "../..");

test("selects and runs slash commands from the composer with the keyboard", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "cake-slash-command-smoke-"));
  const userData = join(temporaryRoot, "user-data");
  const project = join(temporaryRoot, "project");
  const cakeHome = join(temporaryRoot, "cake-home");
  const home = join(temporaryRoot, "home");
  const requests: Array<{
    messages: Array<{ role: string; content: string | Array<{ type: string; text?: string }> }>;
  }> = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += String(chunk);
    });
    request.on("end", () => {
      requests.push(JSON.parse(body));
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        `data: ${JSON.stringify({ id: "slash-fixture", object: "chat.completion.chunk", created: 0, model: "slash-fixture", choices: [{ index: 0, delta: { content: "Fixture response." }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const skillDirectory = join(project, ".agents", "skills", "desktop-fixture");
  await Promise.all([
    mkdir(userData, { recursive: true }),
    mkdir(skillDirectory, { recursive: true }),
    mkdir(home, { recursive: true }),
    mkdir(join(cakeHome, "pi"), { recursive: true }),
  ]);
  await writeFile(
    join(cakeHome, "pi", "settings.json"),
    JSON.stringify({ defaultProvider: "slash-provider", defaultModel: "slash-fixture" }),
  );
  await writeFile(join(cakeHome, "pi", "auth.json"), "{}");
  await writeFile(
    join(cakeHome, "pi", "models.json"),
    JSON.stringify({
      providers: {
        "slash-provider": {
          name: "Slash provider",
          baseUrl: `${origin}/v1`,
          apiKey: "fixture-only",
          api: "openai-completions",
          models: [
            {
              id: "slash-fixture",
              name: "Slash fixture",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 4096,
              maxTokens: 1024,
            },
          ],
        },
      },
    }),
  );
  await writeFile(join(project, "notes.txt"), "Fixture notes.\n");
  await writeFile(
    join(skillDirectory, "SKILL.md"),
    "---\nname: desktop-fixture\ndescription: Desktop fixture skill\n---\nFixture.\n",
  );
  await writeFile(join(userData, "window-state.json"), windowState({ project, theme: "system" }));
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
    }),
  );

  const dictationModel = join(userData, "dictation", "model");
  await mkdir(dictationModel, { recursive: true });
  await writeFile(
    join(userData, "dictation", "settings.json"),
    JSON.stringify({ modelPath: dictationModel }),
  );
  const helper = join(temporaryRoot, "dictation-helper");
  // Replace only native recognition; real preferences, Store, audio, focus, and delivery remain.
  await writeFile(
    helper,
    `#!${process.execPath}
const readline = require('node:readline');
console.log(JSON.stringify({ ready: true }));
readline.createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  console.log(JSON.stringify(request.operation === 'detectSpeech' ? { speech: false } : { text: '' }));
});
`,
  );
  await chmod(helper, 0o755);
  const application = await electron.launch({
    args: [repositoryRoot, "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
    cwd: repositoryRoot,
    env: {
      PATH: process.env.PATH,
      TMPDIR: process.env.TMPDIR,
      LANG: process.env.LANG,
      HOME: home,
      CAKE_ELECTRON_SMOKE: "1",
      CAKE_SMOKE_DICTATION_HELPER: helper,
      CAKE_ELECTRON_USER_DATA: userData,
      CAKE_HOME: cakeHome,
      PI_CODING_AGENT_DIR: join(cakeHome, "pi"),
      PI_CODING_AGENT_SESSION_DIR: "",
    },
  });

  try {
    const page = await application.firstWindow();
    const composer = page.getByRole("combobox", { name: "Message", exact: true });
    await expect(composer).toBeVisible({ timeout: 20_000 });
    expect(await installLocalModelHttpGuard(application, origin)).toEqual({
      allowedOrigin: origin,
      installed: true,
    });

    const initialHeight = await composer.evaluate((input) => input.getBoundingClientRect().height);
    // Voice controls live in the toolbar, leaving a single initial input row.
    expect(initialHeight).toBe(40);

    await composer.click();
    await expect(composer).toBeFocused();
    await composer.pressSequentially("hello");
    await expect(composer).toHaveValue("hello");
    await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();

    await composer.fill("Explain @no");
    await expect(page.getByRole("option", { name: /notes\.txt/ })).toBeVisible();
    await composer.press("Tab");
    await expect(composer).toHaveValue("Explain @notes.txt ");
    await expect(composer).toBeFocused();
    await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();

    await composer.fill(Array.from({ length: 30 }, (_, index) => `Line ${index + 1}`).join("\n"));
    const expandedSize = await composer.evaluate((input) => ({
      height: input.getBoundingClientRect().height,
      scrollHeight: input.scrollHeight,
    }));
    expect(expandedSize.height).toBeGreaterThan(initialHeight);
    expect(expandedSize.height).toBeLessThanOrEqual(321);
    expect(expandedSize.scrollHeight).toBeGreaterThan(expandedSize.height);

    await composer.fill("existing prompt");
    await composer.press("Home");
    await composer.pressSequentially("/");
    await expect(page.getByRole("listbox", { name: "Slash commands" })).toBeVisible();
    await expect(page.getByRole("option", { name: /compact/ })).toHaveCount(0);
    await expect(page.getByRole("option", { name: /toolcompact/ })).toHaveCount(0);
    await composer.press("Tab");
    await expect(composer).toHaveValue("/model existing prompt");

    await composer.fill("/tree");
    await composer.press("Enter");
    await expect(page.getByRole("complementary", { name: "Session tree" })).toBeVisible();

    await page.getByRole("button", { name: "New chat in project", exact: true }).click();
    await composer.fill("/skill:desktop");
    await expect(
      page.getByRole("option", { name: /skill:desktop-fixture Desktop fixture skill/ }),
    ).toBeVisible();
    await composer.press("Tab");
    await expect(composer).toHaveValue("/skill:desktop-fixture ");
    await composer.press("Enter");
    await expect(page.locator(".session-item.active")).toHaveCount(1, { timeout: 20_000 });
    await expect(composer).toHaveValue("");

    // Tool Compact must send the continuation through ordinary attachment admission,
    // not the text-only continuation parameter. Exercise the real native composer.
    await expect(
      page
        .getByLabel("Conversation", { exact: true })
        .getByText("Fixture response.", { exact: true }),
    ).toBeVisible();
    await composer.click();
    await expect(composer).toBeFocused();
    const log = "ATTACHED_LOG\n" + "log details\n".repeat(50);
    await composer.evaluate((element, log) => {
      const clipboard = new DataTransfer();
      clipboard.setData("text/plain", log);
      element.dispatchEvent(
        new ClipboardEvent("paste", {
          bubbles: true,
          cancelable: true,
          clipboardData: clipboard,
        }),
      );
    }, log);
    const removeAttachment = page.getByRole("button", { name: /^Remove Pasted text/ });
    await expect(removeAttachment).toHaveCount(1);
    await composer.pressSequentially("/toolcompact Review attached log");
    await expect(composer).toHaveValue("/toolcompact Review attached log");
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
    const continuationRequests = () =>
      requests.filter((request) =>
        JSON.stringify(
          request.messages.findLast((message) => message.role === "user")?.content,
        )?.includes("Review attached log"),
      );
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect.poll(() => continuationRequests().length).toBe(1);
    const content = continuationRequests()[0]!.messages.findLast(
      (message) => message.role === "user",
    )!.content;
    const sent =
      typeof content === "string"
        ? content
        : content
            .filter((block) => block.type === "text")
            .map((block) => block.text)
            .join("\n");
    expect(sent).toContain("Pasted text · 52 lines");
    expect(sent).toContain("inputReference");
    const attachments = [...sent.matchAll(/<cake-file-attachment>(.*?)<\/cake-file-attachment>/g)];
    expect(attachments).toHaveLength(1);
    const attachment = JSON.parse(attachments[0]![1]!);
    expect(await readFile(attachment.path, "utf8")).toBe(log);
    await expect(composer).toHaveValue("");
    await expect(removeAttachment).toHaveCount(0);

    if (process.platform === "darwin" && process.arch === "arm64") {
      await page.getByRole("button", { name: "Open settings", exact: true }).click();
      await page.getByRole("button", { name: /Voice & Dictation/ }).click();
      await page.getByRole("switch", { name: "Dictation mode" }).click();
      await page.getByRole("button", { name: "Back to chat" }).click();
      const anchor = page.getByRole("group", { name: "Press Tab to write", exact: true });
      await expect(anchor).toBeFocused();
      await expect(composer).not.toBeFocused();
      await page.keyboard.press("Tab");
      await expect(composer).toBeFocused();
      await expect(page.locator('[data-slot="dictation-indicator"]')).toHaveText("Listening");
      // The visible menu revokes this focused field's dictation target, not the global
      // preference. Refocusing cannot start capture until the menu is dismissed.
      await composer.fill("/");
      await expect(page.getByRole("listbox", { name: "Slash commands" })).toBeVisible();
      await expect(page.locator('[data-slot="dictation-indicator"]')).toHaveCount(0);
      await composer.focus();
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await expect(page.locator('[data-slot="dictation-indicator"]')).toHaveCount(0);
      await composer.press("Escape");
      await expect(page.getByRole("listbox", { name: "Slash commands" })).toHaveCount(0);
      await expect(composer).toHaveValue("/");
      await expect(composer).toBeFocused();
      await expect(page.locator('[data-slot="dictation-indicator"]')).toHaveText("Listening");

      // Slash completion is an explicit writing action, not convenience autofocus.
      for (const key of ["Tab", "ArrowLeft", "ArrowRight"]) {
        await composer.fill("/skill:desktop");
        await expect(page.getByRole("listbox", { name: "Slash commands" })).toBeVisible();
        await expect(page.locator('[data-slot="dictation-indicator"]')).toHaveCount(0);
        await page.keyboard.press(key);
        await expect(composer).toHaveValue("/skill:desktop-fixture ");
        await expect(composer).toBeFocused();
        await expect(page.locator('[data-slot="dictation-indicator"]')).toHaveText("Listening");
        await page.keyboard.type("command argument");
        await expect(composer).toHaveValue("/skill:desktop-fixture command argument");
        await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
      }
      await composer.fill("/skill:desktop");
      await page
        .getByRole("option", { name: /skill:desktop-fixture Desktop fixture skill/ })
        .click();
      await expect(composer).toHaveValue("/skill:desktop-fixture ");
      await expect(composer).toBeFocused();
      await page.keyboard.type("clicked command argument");
      await expect(composer).toHaveValue("/skill:desktop-fixture clicked command argument");
      await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();

      await composer.fill("");
      await page.keyboard.type("Send without restarting dictation");
      await expect(composer).toHaveValue("Send without restarting dictation");
      await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
      await page.keyboard.press("Enter");
      await expect(composer).toHaveValue("");
      await expect(anchor).toBeFocused();
      await expect(page.locator('[data-slot="dictation-indicator"]')).toHaveCount(0);
      await page.keyboard.press("Tab");
      await expect(composer).toBeFocused();
      await page.keyboard.type("Next deliberate draft");
      await expect(composer).toHaveValue("Next deliberate draft");
      await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
    }
  } finally {
    await application.close();
    server.closeAllConnections();
    server.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
