import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "../../scripts/queued-electron.mjs";
import { expect, test } from "@playwright/test";
import { findVisualCaptureScenario } from "../../scripts/visual-capture/scenarios";
import { installLocalModelHttpGuard } from "./main-harness";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const reply =
  "A reply to read\n\n[Read documentation](https://example.com/docs)\n\n```ts\nconst companion = 'ready';\n```";
function chunk(content: string, finishReason: string | null = null) {
  return `data: ${JSON.stringify({ id: "popup-reply", object: "chat.completion.chunk", created: 0, model: "fixture", choices: [{ index: 0, delta: { content }, finish_reason: finishReason }] })}\n\n`;
}

test("companion replies persist, support reading and links, and dismiss without stopping work or reclaiming focus", async () => {
  test.setTimeout(60_000);
  const root = await mkdtemp(join(tmpdir(), "cake-companion-response-"));
  const paths = {
    cakeHome: join(root, "cake-home"),
    project: join(root, "project"),
    userData: join(root, "user-data"),
  };
  const scenario = findVisualCaptureScenario("dictation-input")!;
  await scenario.seed(paths, "dark");
  let requests = 0;
  let releaseReply: (() => void) | undefined;
  let releaseStream: (() => void) | undefined;
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const part of request) body += part;
    response.writeHead(200, { "content-type": "text/event-stream" });
    if (/Compaction: (?:compress message|merge lines)/.test(body)) {
      response.end(chunk("work: companion popup") + chunk("", "stop") + "data: [DONE]\n\n");
      return;
    }
    requests += 1;
    if (requests === 1) {
      await new Promise<void>((resolveReply) => {
        releaseReply = resolveReply;
      });
      response.end(chunk(reply) + chunk("", "stop") + "data: [DONE]\n\n");
    } else {
      response.write(chunk("First streamed words"));
      await new Promise<void>((resolveStream) => {
        releaseStream = resolveStream;
      });
      response.end(chunk(" and the rest of the reply.") + chunk("", "stop") + "data: [DONE]\n\n");
    }
  });
  await new Promise<void>((resolveServer) => server.listen(0, "127.0.0.1", resolveServer));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const stateFile = join(paths.cakeHome, "state", "application.json");
  const state = JSON.parse(await readFile(stateFile, "utf8"));
  await writeFile(
    stateFile,
    JSON.stringify({
      ...state,
      utilityModel: { provider: "conversation-visual", modelId: "fixture", thinkingLevel: "off" },
    }),
  );
  const modelsFile = join(paths.cakeHome, "pi", "models.json");
  const models = JSON.parse(await readFile(modelsFile, "utf8"));
  models.providers["conversation-visual"].baseUrl = `${origin}/v1`;
  models.providers["conversation-visual"].models[0].contextWindow = 128_000;
  await writeFile(modelsFile, JSON.stringify(models));
  const application = await electron.launch({
    args: [repositoryRoot],
    cwd: repositoryRoot,
    env: {
      ...process.env,
      CAKE_ELECTRON_SMOKE: "1",
      CAKE_ELECTRON_USER_DATA: paths.userData,
      CAKE_HOME: paths.cakeHome,
      PI_CODING_AGENT_DIR: join(paths.cakeHome, "pi"),
      PI_CODING_AGENT_SESSION_DIR: "",
    },
  });
  try {
    await installLocalModelHttpGuard(application, origin);
    await application.evaluate(({ shell }) => {
      const urls: string[] = [];
      Object.assign(globalThis, { companionExternalUrls: urls });
      Object.defineProperty(shell, "openExternal", {
        configurable: true,
        value: async (url: string) => {
          urls.push(url);
        },
      });
    });
    const page = await application.firstWindow();
    const trigger = page.getByRole("button", { name: "Ask session assistant", exact: true });
    await expect(trigger).toBeVisible({ timeout: 20_000 });
    await trigger.click();
    const quick = page.getByRole("dialog", { name: "Quick session assistant", exact: true });
    const quickInput = quick.getByRole("combobox", { name: "Ask session assistant", exact: true });
    await expect(quickInput).toBeFocused();
    await quickInput.pressSequentially("Find the plan");
    await expect(quickInput).toHaveValue("Find the plan");
    await expect(quick.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
    await quickInput.press("Enter");
    await expect(
      quick.getByRole("status", { name: "Session assistant is thinking", exact: true }),
    ).toBeVisible();
    await expect.poll(() => Boolean(releaseReply)).toBe(true);
    await page.keyboard.press("Escape");
    await expect(quick).toHaveCount(0);
    await trigger.click();
    await expect(
      quick.getByRole("status", { name: "Session assistant is thinking", exact: true }),
    ).toBeVisible();
    releaseReply?.();
    const prose = quick.getByText("A reply to read", { exact: true });
    await expect(prose).toBeVisible();
    // The interval itself is the regression: a reply must survive the former 5s deadline.
    await page.waitForTimeout(6_000);
    await expect(prose).toBeVisible();
    const code = quick.locator('[data-streamdown="code-block-body"] code');
    await expect(code.locator("span span").first()).toBeVisible();
    for (const target of [prose, code]) {
      await target.dblclick();
      await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).not.toBe("");
      await expect(quick).toBeVisible();
    }
    await quick.getByRole("link", { name: "Read documentation", exact: true }).click();
    await expect
      .poll(() => application.evaluate(() => Reflect.get(globalThis, "companionExternalUrls")))
      .toEqual(["https://example.com/docs"]);
    await expect(quick).toBeVisible();
    // A response bubble has no input; the shortcut reveals the same conversation's composer.
    await page.keyboard.press(`${process.platform === "darwin" ? "Meta" : "Control"}+Shift+J`);
    const full = page.getByRole("dialog", { name: "Session assistant chat", exact: true });
    const input = full.getByRole("combobox", { name: "Message session assistant", exact: true });
    await expect(input).toBeFocused();
    await expect(full.getByText("Find the plan", { exact: true })).toBeVisible();
    await input.pressSequentially("Continue the plan");
    await input.press("Shift+Enter");
    await input.pressSequentially("Second line");
    await expect(input).toHaveValue("Continue the plan\nSecond line");
    const send = full.getByRole("button", { name: "Send", exact: true });
    await expect(send).toBeEnabled();
    await send.click();
    await expect(input).toHaveValue("");
    await expect(full.getByText("First streamed words", { exact: true })).toBeVisible();
    const close = full.getByRole("button", { name: "Close companion", exact: true });
    await close.focus();
    await expect.poll(() => Boolean(releaseStream)).toBe(true);
    releaseStream?.();
    const completed = full.getByText("First streamed words and the rest of the reply.", {
      exact: true,
    });
    await expect(completed).toBeVisible();
    await expect(close).toBeFocused();
    await page
      .locator(".transcript")
      .first()
      .click({ position: { x: 20, y: 20 } });
    await expect(full).toHaveCount(0);
    await trigger.click({ button: "right" });
    await expect(input).toBeFocused();
    await expect(completed).toBeVisible();
    await input.press("Escape");
    await expect(full).toHaveCount(0);
    expect(requests).toBe(2);
  } finally {
    releaseReply?.();
    releaseStream?.();
    await application.close();
    server.close();
    await rm(root, { recursive: true, force: true });
  }
});
