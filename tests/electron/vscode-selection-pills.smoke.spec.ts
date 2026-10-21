import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";
import type { JsonObject } from "../../src/contracts/serialization/json-contract";
import { cakeWorkspaceSessionDirectory } from "../../src/services/pi/runtime/session-discovery";
import { emitRendererEvent, installLocalModelHttpGuard } from "./main-harness";
import { windowState } from "../fixtures/window-state";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const sessionId = "selection-tour";

async function fixture() {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "cake-selection-pills-"));
  const project = join(temporaryRoot, "project");
  const userData = join(temporaryRoot, "user-data");
  const cakeHome = join(temporaryRoot, "cake-home");
  const sessionDirectory = cakeWorkspaceSessionDirectory(project, join(cakeHome, "pi", "sessions"));
  await Promise.all([
    mkdir(join(project, "src"), { recursive: true }),
    mkdir(userData, { recursive: true }),
    mkdir(join(cakeHome, "state"), { recursive: true }),
    mkdir(sessionDirectory, { recursive: true }),
  ]);
  for (const filename of ["a.ts", "b.ts"])
    await writeFile(
      join(project, "src", filename),
      Array.from(
        { length: 200 },
        (_, index) => `export const line${index + 1} = ${index + 1};`,
      ).join("\n"),
    );
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(
      `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 0, model: "fixture", choices: [{ index: 0, delta: { role: "assistant", content: "Selection received." }, finish_reason: null }] })}\n\n` +
        `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 0, model: "fixture", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture server address");
  await writeFile(
    join(cakeHome, "pi", "models.json"),
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
              contextWindow: 32_000,
              maxTokens: 1024,
            },
          ],
        },
      },
    }),
  );
  const timestamp = new Date(0).toISOString();
  await writeFile(
    join(userData, "window-state.json"),
    windowState({ project, sessionId, theme: "dark" }),
  );
  await writeFile(
    join(cakeHome, "state", "application.json"),
    JSON.stringify({
      schemaVersion: 1,
      projects: [{ path: project, name: "project", addedAt: timestamp, lastOpenedAt: timestamp }],
      trustedProjectPaths: [project],
    }),
  );
  await writeFile(
    join(sessionDirectory, `1970-01-01T00-00-00-000Z_${sessionId}.jsonl`),
    [
      { type: "session", version: 3, id: sessionId, timestamp, cwd: project },
      {
        type: "model_change",
        id: "model",
        parentId: null,
        timestamp,
        provider: "fixture",
        modelId: "fixture",
      },
      {
        type: "message",
        id: "user-1",
        parentId: "model",
        timestamp,
        message: {
          role: "user",
          content: [{ type: "text", text: "Give me a code tour" }],
          timestamp: 0,
        },
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n") + "\n",
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
    },
  });
  const page = await application.firstWindow();
  const command = (command: string, input: JsonObject = {}) =>
    emitRendererEvent(application, {
      type: "project-session-control-requested",
      sessionId,
      controlRequestId: randomUUID(),
      invocation: { _tag: "InvokeAppControl", command, input },
    });
  await expect(page.getByLabel("Message", { exact: true })).toBeVisible({ timeout: 20_000 });
  await installLocalModelHttpGuard(application, `http://127.0.0.1:${address.port}`);
  await page.getByRole("button", { name: "Model configuration" }).click();
  const search = page.getByLabel("Search presets and models");
  const changeModel = page.getByRole("button", { name: /Change model/ });
  await expect
    .poll(async () => (await search.isVisible()) || (await changeModel.isVisible()))
    .toBe(true);
  if (await changeModel.isVisible()) await changeModel.click();
  await search.fill("Fixture");
  await page
    .getByRole("button", { name: /Fixture.*fixture/ })
    .first()
    .click();
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(search).toBeHidden();
  await command("vscode.enter");
  await expect(page.getByRole("region", { name: "VS Code workspace" })).toBeVisible({
    timeout: 20_000,
  });
  const pills = page.locator('[aria-label="Editor selections"]');
  const open = async (path = "src/a.ts", line = 100, extra: JsonObject = {}) => {
    await command("vscode.open", { path, line, endLine: line + 2, ...extra });
    await expect(
      pills
        .getByRole("button", { name: new RegExp(`^Reveal .*${path.replaceAll(".", "\\.")}`) })
        .first(),
    ).toBeVisible({ timeout: 20_000 });
  };
  return {
    application,
    page,
    project,
    command,
    pills,
    open,
    close: async () => {
      await application.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(temporaryRoot, { recursive: true, force: true });
    },
  };
}

async function editorState(application: ElectronApplication) {
  return application.evaluate(async ({ webContents }) => {
    for (const contents of webContents.getAllWebContents()) {
      if (!contents.getURL().startsWith("http://127.0.0.1:")) continue;
      return contents.executeJavaScript(
        `({ tabs: [...document.querySelectorAll('.tab.active')].map(tab => tab.textContent.trim()), text: [...document.querySelectorAll('.view-lines')].map(lines => lines.textContent).join(' ') })`,
      );
    }
    return undefined;
  });
}

test.beforeEach(() => {
  test.setTimeout(60_000);
});

test("agent selections appear outside the input above the composer and clicks reveal the exact range", async () => {
  const h = await fixture();
  try {
    await h.open();
    await h.open("src/b.ts", 20);
    await expect(h.pills.getByRole("button", { name: /^Reveal / })).toHaveCount(2);
    await h.pills.getByRole("button", { name: /^Reveal .*src\/a\.ts/ }).click();
    await expect
      .poll(() => editorState(h.application))
      .toMatchObject({ tabs: ["a.ts"], text: expect.stringContaining("line100") });
    const pillBounds = await h.pills.boundingBox();
    const composerBounds = await h.page.locator("form").boundingBox();
    expect(pillBounds!.y + pillBounds!.height).toBeLessThanOrEqual(composerBounds!.y);
    await expect(h.page.locator("form").locator('[aria-label="Editor selections"]')).toHaveCount(0);
    await expect(h.pills.getByRole("button", { name: /^Reveal / })).toHaveCount(2);
  } finally {
    await h.close();
  }
});

test("mouse and keyboard dismissal remove only the chosen pill without invoking navigation", async () => {
  const h = await fixture();
  try {
    await h.open();
    await h.open("src/b.ts", 20);
    await expect.poll(() => editorState(h.application)).toMatchObject({ tabs: ["b.ts"] });
    await h.pills.getByRole("button", { name: /^Remove .*src\/a\.ts/ }).click();
    await expect(h.pills.getByRole("button", { name: /^Reveal / })).toHaveCount(1);
    await expect.poll(() => editorState(h.application)).toMatchObject({ tabs: ["b.ts"] });
    const remove = h.pills.getByRole("button", { name: /^Remove / });
    await remove.focus();
    await expect(remove).toBeFocused();
    await h.page.keyboard.press("Enter");
    await expect(h.pills).toHaveCount(0);
    await expect.poll(() => editorState(h.application)).toMatchObject({ tabs: ["b.ts"] });
  } finally {
    await h.close();
  }
});

test("switching files and showing the same document in two editors retains one pill per selection", async () => {
  const h = await fixture();
  try {
    await h.open();
    await h.open("src/b.ts", 20);
    await h.open("src/a.ts", 100, { group: "beside", preview: false });
    await expect
      .poll(() => editorState(h.application))
      .toMatchObject({ tabs: expect.arrayContaining(["a.ts", "b.ts"]) });
    await expect(h.pills.getByRole("button", { name: /^Reveal / })).toHaveCount(2);
    await h.open("src/a.ts", 100, { group: "one", preview: false });
    await expect.poll(() => editorState(h.application)).toMatchObject({ tabs: ["a.ts", "a.ts"] });
    await expect(h.pills.getByRole("button", { name: /^Reveal / })).toHaveCount(2);
  } finally {
    await h.close();
  }
});

test("a user-selected source opens on click, appears in the sent message, and leaves the composer", async () => {
  const h = await fixture();
  try {
    await h.open("src/b.ts", 20);
    await expect.poll(() => editorState(h.application)).toMatchObject({ tabs: ["b.ts"] });
    await emitRendererEvent(h.application, {
      type: "embedded-editor-selection",
      workspacePath: h.project,
      path: "src/a.ts",
      startLine: 3,
      endLine: 4,
    });
    const attachment = h.page.getByRole("button", { name: "src/a.ts#L4-L5", exact: true });
    await expect(attachment).toBeVisible();
    const source = h.page.getByRole("button", {
      name: "Open src/a.ts#L4-L5",
      exact: true,
    });
    const input = h.page.getByLabel("Message", { exact: true });
    await input.focus();
    await expect(attachment).toBeVisible();
    await input.pressSequentially("What is this selection?");
    await h.page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(attachment).toHaveCount(0);
    await expect(h.page.getByText("What is this selection?", { exact: true })).toBeVisible();
    await expect(source).toBeVisible();
    await expect.poll(() => editorState(h.application)).toMatchObject({ tabs: ["b.ts"] });
    await source.click();
    await expect.poll(() => editorState(h.application)).toMatchObject({ tabs: ["a.ts"] });
  } finally {
    await h.close();
  }
});

test("pill interactions preserve normal composer focus, typing, submission, and retained selections", async () => {
  const h = await fixture();
  try {
    await h.open();
    await h.open("src/b.ts", 20);
    await h.pills.getByRole("button", { name: /^Reveal .*src\/a\.ts/ }).click();
    await h.pills.getByRole("button", { name: /^Remove .*src\/b\.ts/ }).click();
    const input = h.page.getByLabel("Message", { exact: true });
    await input.click();
    await expect(input).toBeFocused();
    await h.page.keyboard.type("Explain this selected range");
    await expect(input).toHaveValue("Explain this selected range");
    const send = h.page.getByRole("button", { name: "Send", exact: true });
    await expect(send).toBeEnabled();
    await send.click();
    await expect(
      h.page.getByText("Explain this selected range", { exact: true }).first(),
    ).toBeVisible();
    await expect(h.pills.getByRole("button", { name: /^Reveal / })).toHaveCount(1);
  } finally {
    await h.close();
  }
});
