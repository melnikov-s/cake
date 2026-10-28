import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { findVisualCaptureScenario } from "../../scripts/visual-capture/scenarios";
import { cakeWorkspaceSessionDirectory } from "../../src/services/pi/runtime/session-discovery";
import { installLocalModelHttpGuard } from "./main-harness";

const repositoryRoot = resolve(import.meta.dirname, "../..");

test("sending alongside an old artifact preserves its live frame and supplies exact host context", async () => {
  test.setTimeout(60_000);
  const root = await mkdtemp(join(tmpdir(), "cake-presentation-chat-"));
  const paths = {
    cakeHome: join(root, "cake-home"),
    project: join(root, "project"),
    userData: join(root, "user-data"),
  };
  const requests: string[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += String(chunk);
    });
    request.on("end", () => {
      requests.push(body);
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        `data: ${JSON.stringify({ id: "presentation-fixture", object: "chat.completion.chunk", created: 0, model: "fixture-model", choices: [{ index: 0, delta: { content: "Presentation request received." }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await findVisualCaptureScenario("inline-artifact")!.seed(paths, "dark");
  await mkdir(join(paths.cakeHome, "pi"), { recursive: true });
  await writeFile(
    join(paths.cakeHome, "pi", "models.json"),
    JSON.stringify({
      providers: {
        "presentation-provider": {
          baseUrl: `${origin}/v1`,
          apiKey: "fixture",
          api: "openai-completions",
          models: [
            {
              id: "fixture-model",
              name: "Presentation fixture",
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
  const sessionFile = join(
    cakeWorkspaceSessionDirectory(paths.project, join(paths.cakeHome, "pi", "sessions")),
    "1970-01-01T00-00-00-000Z_visual-inline-artifact.jsonl",
  );
  const entries = (await readFile(sessionFile, "utf8"))
    .trim()
    .split("\n")
    .map((line): { type: string; id: string; parentId?: string | null } => JSON.parse(line));
  entries.splice(1, 0, {
    type: "model_change",
    id: "presentation-model",
    parentId: null,
    ...{
      provider: "presentation-provider",
      modelId: "fixture-model",
      timestamp: new Date(0).toISOString(),
    },
  });
  entries[2]!.parentId = "presentation-model";
  let parentId = entries.at(-1)!.id;
  for (let index = 0; index < 36; index++) {
    const id = `later-message-${index}`;
    entries.push({
      type: "message",
      id,
      parentId,
      ...{
        timestamp: new Date(index + 1).toISOString(),
        message: {
          role: index % 2 ? "assistant" : "user",
          content: [
            {
              type: "text",
              text: `Later conversation ${index}. ${"A later topic that should not replace the presentation. ".repeat(30)}`,
            },
          ],
          timestamp: index + 1,
          api: "openai-completions",
          provider: "presentation-provider",
          model: "fixture-model",
          stopReason: "stop",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        },
      },
    });
    parentId = id;
  }
  await writeFile(sessionFile, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  const app = await electron.launch({
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
    await installLocalModelHttpGuard(app, origin);
    const page = await app.firstWindow();
    await expect(page.getByRole("combobox", { name: "Message", exact: true })).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByText(/^Later conversation 35/)).toBeVisible();
    await page
      .locator(".transcript")
      .first()
      .evaluate((element) => {
        element.dispatchEvent(new WheelEvent("wheel", { deltaY: -100000, bubbles: true }));
        element.scrollTop = 0;
      });
    const inline = page.locator('[data-slot="artifact-disclosure"]').first();
    await expect(
      inline
        .locator("iframe")
        .contentFrame()
        .getByRole("heading", { name: "One artifact, two views" }),
    ).toBeVisible();
    const originalSrc = await inline.locator("iframe").getAttribute("src");
    await expect(inline.locator("iframe").contentFrame().locator("html")).toHaveAttribute(
      "data-cake-widget-ready",
      "true",
    );
    const explore = inline
      .locator("iframe")
      .contentFrame()
      .getByRole("button", { name: "Explore detail" });
    await explore.focus();
    await explore.press("Enter");
    await expect(
      inline.locator("iframe").contentFrame().getByRole("button", { name: "Hide detail" }),
    ).toBeVisible();
    await inline
      .locator("iframe")
      .contentFrame()
      .locator("main")
      .evaluate((element) => {
        element.dataset.presentationUnsaved = "retained";
      });
    await inline.getByRole("button", { name: "View Inline visualization fullscreen" }).click();
    const fullscreen = page.getByRole("dialog", { name: "Inline visualization" });
    await expect(
      fullscreen
        .locator('section[aria-label="Inline visualization"] iframe')
        .contentFrame()
        .locator("main"),
    ).toHaveAttribute("data-presentation-unsaved", "retained");
    await fullscreen.getByRole("button", { name: "Open chat" }).click();
    const input = fullscreen.getByRole("combobox", { name: "Message", exact: true });
    await input.fill("edit it in presentation");
    await input.press("Enter");
    await expect
      .poll(() => requests.some((body) => body.includes("edit it in presentation")))
      .toBe(true);
    const sent = requests.find((body) => body.includes("edit it in presentation"))!;
    expect(sent).toContain('\\"artifactId\\":\\"inline-visual\\"');
    expect(sent).toContain("cake://artifact/inline-visual@r1");
    expect(sent).toContain("Cake application view at submission");
    expect(sent).toContain('\\"revision\\":1');
    expect(sent).toContain('\\"title\\":\\"Inline visualization\\"');
    expect(sent).toContain('\\"type\\":\\"widget\\"');
    expect(sent).toContain('\\"sessionId\\":\\"visual-inline-artifact\\"');
    await expect(fullscreen).toBeVisible();
    await expect(fullscreen.getByText("edit it in presentation", { exact: true })).toBeVisible();
    const frame = fullscreen.locator('section[aria-label="Inline visualization"] iframe');
    await expect(frame).toHaveAttribute("src", originalSrc!);
    await expect(frame.contentFrame().locator("main")).toHaveAttribute(
      "data-presentation-unsaved",
      "retained",
    );
    await expect(frame.contentFrame().getByRole("button", { name: "Hide detail" })).toBeVisible();
    await fullscreen.getByRole("button", { name: "Exit fullscreen Inline visualization" }).click();
    const normal = page.getByRole("combobox", { name: "Message", exact: true });
    await normal.fill("after leaving presentation");
    await normal.press("Enter");
    await expect
      .poll(() => requests.some((body) => body.includes("after leaving presentation")))
      .toBe(true);
    const lastRequest = JSON.parse(
      requests.findLast((body) => body.includes("after leaving presentation"))!,
    );
    expect(JSON.stringify(lastRequest.messages.at(-1))).toContain(
      '\\"artifactPresentation\\":null',
    );
  } finally {
    await app.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
