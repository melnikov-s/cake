import { createServer } from "node:http";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";
import { CAKE_CHAT_SESSION_ID } from "../../src/ipc/cake-chat-data";
import { defaultApplicationState } from "../../src/contracts/application/application-data";

const repositoryRoot = resolve(import.meta.dirname, "../..");

// Exercise the real native menu builder/handler without presenting an OS popup.
async function interceptMenu(app: ElectronApplication, choose?: string) {
  await app.evaluate(({ Menu }, selected) => {
    const state = globalThis as typeof globalThis & {
      cakeSidebarMenu?: { label: string; enabled: boolean }[];
    };
    state.cakeSidebarMenu = undefined;
    const original = Menu.buildFromTemplate;
    Menu.buildFromTemplate = (template) => {
      Menu.buildFromTemplate = original;
      const menu = original(template);
      state.cakeSidebarMenu = menu.items.map(({ label, enabled }) => ({ label, enabled }));
      menu.popup = (options) => {
        const item = menu.items.find((item) => item.label === selected);
        if (item?.enabled) Reflect.apply(item.click, item, [item, undefined, {}]);
        options?.callback?.();
      };
      return menu;
    };
  }, choose);
}
async function menuItems(app: ElectronApplication) {
  return app.evaluate(
    () =>
      (
        globalThis as typeof globalThis & {
          cakeSidebarMenu?: { label: string; enabled: boolean }[];
        }
      ).cakeSidebarMenu,
  );
}

function seedHistory(directory: string, text: string) {
  const manager = SessionManager.create(homedir(), directory);
  manager.appendMessage({ role: "user", content: text, timestamp: Date.now() });
  manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "Saved reply" }],
    api: "openai-completions",
    provider: "fixture",
    model: "fixture",
    stopReason: "stop",
    timestamp: Date.now(),
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  });
  return manager.getSessionFile()!;
}

test("permanent Cake Chat retains its input, history and settings across restart and resets only old global histories", async () => {
  test.setTimeout(90_000);
  const root = await mkdtemp(join(tmpdir(), "cake-chat-smoke-"));
  const cakeHome = join(root, "cake-home");
  const userData = join(root, "user-data");
  const document = join(cakeHome, "state", "application.json");
  const activeDirectory = join(cakeHome, "pi", "global-chat", "sessions");
  const resolvedDirectory = join(cakeHome, "pi", "global-chat", "resolved-sessions");
  await Promise.all([
    mkdir(join(cakeHome, "state"), { recursive: true }),
    mkdir(join(cakeHome, "pi"), { recursive: true }),
    mkdir(userData),
  ]);
  const oldActive = seedHistory(activeDirectory, "Old active global conversation");
  const oldResolved = seedHistory(resolvedDirectory, "Old resolved global conversation");
  const projectFile = seedHistory(join(root, "project-sessions"), "Independent project work");
  const projectHistory = await readFile(projectFile, "utf8");
  const requests: unknown[] = [];
  let releaseFirstReply: (() => void) | undefined;
  const firstReplyGate = new Promise<void>((resolve) => {
    releaseFirstReply = resolve;
  });
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const parsed: unknown = JSON.parse(body);
    const summary = JSON.stringify(parsed).includes("You write the memory of Cake Chat");
    if (!summary) {
      requests.push(parsed);
      if (requests.length === 1) await firstReplyGate;
    }
    const text = summary
      ? "talk: coordinated project work; user asked about priorities"
      : `Coordinator reply. ${"Detailed task context. ".repeat(50)}`;
    response.writeHead(200, { "content-type": "text/event-stream" });
    const chunk = (delta: object, finish_reason: string | null) =>
      `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 0, model: "fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
    response.write(chunk({ role: "assistant", content: text }, null));
    response.write(chunk({}, "stop"));
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No fixture address");
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
              contextWindow: 200_000,
              maxTokens: 4_096,
            },
          ],
        },
      },
    }),
  );
  const presetId = "00000000-0000-4000-8000-000000000001";
  await writeFile(
    document,
    JSON.stringify({
      version: 6,
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
  const launch = () =>
    electron.launch({
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
  const preferences = async () =>
    JSON.parse(await readFile(document, "utf8")).data.cakeChatPreferences;
  let app = await launch();
  try {
    let page = await app.firstWindow();
    await page.getByRole("button", { name: "Cake Chat", exact: true }).click();
    let input = page.getByRole("combobox", { name: "Message Cake Chat" });
    await input.click();
    await expect(input).toBeFocused();
    const privateLog = "PRIVATE_SIDECAR_LOG\r\n" + "large log line\n".repeat(50);
    await input.evaluate((element, text) => {
      const clipboardData = new DataTransfer();
      clipboardData.setData("text/plain", text);
      element.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }),
      );
    }, privateLog);
    await expect(input).toHaveValue("");
    const pastedChip = page.getByRole("button", { name: /^Pasted text/ });
    await expect(pastedChip).toBeVisible();
    await pastedChip.click();
    await expect(page.locator('[data-cake-private-preview="true"]')).toContainText(
      "PRIVATE_SIDECAR_LOG",
    );
    await page.keyboard.press("Escape");
    const privateImage =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9XkAAAAASUVORK5CYII=";
    await input.evaluate((element, data) => {
      const clipboardData = new DataTransfer();
      clipboardData.items.add(
        new File(
          [Uint8Array.from(atob(data), (character) => character.charCodeAt(0))],
          "pixel.png",
          { type: "image/png" },
        ),
      );
      element.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }),
      );
    }, privateImage);
    await expect(page.getByRole("img", { name: "pixel.png", exact: true })).toBeVisible();
    await input.click();
    await expect(input).toBeFocused();
    await input.pressSequentially("Discuss my priorities");
    await expect(input).toHaveValue("Discuss my priorities");
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Cake Chat", exact: true }).click();
    await expect(input).toHaveValue("Discuss my priorities");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect.poll(() => requests.length).toBeGreaterThan(0);
    expect(JSON.stringify(requests)).not.toContain("PRIVATE_SIDECAR_LOG");
    expect(JSON.stringify(requests)).not.toContain(privateImage);
    expect(JSON.stringify(requests)).not.toContain("image_url");
    expect(JSON.stringify(requests)).toContain("cake-task-input");
    const coordinator = page.locator('[data-slot="cake-chat-group"]');
    await expect(coordinator.getByRole("img", { name: "Running" })).toBeVisible();
    await interceptMenu(app);
    await coordinator.click({ button: "right" });
    await expect
      .poll(() => menuItems(app))
      .toEqual([
        { label: "Mark as Read", enabled: false },
        { label: "Mark as Unread", enabled: false },
        { label: "Copy Session ID", enabled: true },
      ]);
    await page.getByRole("button", { name: "Open Artifact Library", exact: true }).click();
    await expect(coordinator.getByRole("img", { name: "Running" })).toBeVisible();
    releaseFirstReply?.();
    await expect(coordinator.getByRole("img", { name: "Ready, unread" })).toBeVisible();
    await interceptMenu(app, "Mark as Read");
    await coordinator.click({ button: "right" });
    await expect
      .poll(() => menuItems(app))
      .toEqual([
        { label: "Mark as Read", enabled: true },
        { label: "Mark as Unread", enabled: false },
        { label: "Copy Session ID", enabled: true },
      ]);
    await expect(coordinator.getByRole("img")).toHaveCount(0);
    await coordinator.click();
    await expect(page.getByText(/^Coordinator reply\./).first()).toBeVisible();
    await expect(page.locator("[data-context-state]")).toHaveCount(0);
    const database = join(cakeHome, "pi", "global-chat", "coordinator.sqlite");
    await expect
      .poll(() =>
        access(database).then(
          () => true,
          () => false,
        ),
      )
      .toBe(true);
    await expect
      .poll(async () => {
        const storage = await openNodeSqliteStorage(database);
        try {
          return (
            await storage.scanEntries(
              { conversationId: ROOT_CONVERSATION_ID, kind: "cake.chat-memory-node/v1" },
              1,
              undefined,
              BACKGROUND_CONTEXT,
            )
          ).items.length;
        } finally {
          await storage.close(BACKGROUND_CONTEXT);
        }
      })
      .toBe(1);
    await expect
      .poll(() =>
        readFile(oldActive).then(
          () => true,
          () => false,
        ),
      )
      .toBe(false);
    await expect
      .poll(() =>
        readFile(oldResolved).then(
          () => true,
          () => false,
        ),
      )
      .toBe(false);
    expect(await readFile(projectFile, "utf8")).toBe(projectHistory);

    // A manual unread reminder uses the same application storage as Project Sessions.
    await interceptMenu(app, "Mark as Unread");
    await coordinator.click({ button: "right" });
    await expect
      .poll(() => menuItems(app))
      .toEqual([
        { label: "Mark as Read", enabled: false },
        { label: "Mark as Unread", enabled: true },
        { label: "Copy Session ID", enabled: true },
      ]);
    await expect(coordinator.getByRole("img", { name: "Ready, unread" })).toBeVisible();
    await expect
      .poll(async () => JSON.parse(await readFile(document, "utf8")).data.unreadSessionIds)
      .toContain(CAKE_CHAT_SESSION_ID);
    await page.getByRole("button", { name: "Open settings", exact: true }).click();
    await page.getByRole("button", { name: /^Cake Chat\b/ }).click();
    await expect(page.getByRole("combobox", { name: "Cake Chat history-view budget" })).toHaveValue(
      "40000",
    );
    await page
      .getByRole("combobox", { name: "Cake Chat history-view budget" })
      .selectOption("10000");
    const instructions = page.getByRole("textbox", { name: "Cake Chat instructions", exact: true });
    await instructions.click();
    await expect(instructions).toBeFocused();
    await instructions.pressSequentially("Always create a worktree for coding sessions.");
    await instructions.press("Tab");
    await expect.poll(preferences).toMatchObject({
      memoryViewBytes: 10_000,
      instructions: "Always create a worktree for coding sessions.",
    });
    await app.close();
    app = await launch();
    page = await app.firstWindow();
    if (await page.getByRole("button", { name: "Open settings", exact: true }).isVisible()) {
      await page.getByRole("button", { name: "Open settings", exact: true }).click();
    }
    await page.getByRole("button", { name: /^Cake Chat\b/ }).click();
    await expect(
      page.getByRole("textbox", { name: "Cake Chat instructions", exact: true }),
    ).toHaveValue("Always create a worktree for coding sessions.");
    await expect(page.getByRole("combobox", { name: "Cake Chat history-view budget" })).toHaveValue(
      "10000",
    );
    expect(JSON.parse(await readFile(document, "utf8")).data.unreadSessionIds).toContain(
      CAKE_CHAT_SESSION_ID,
    );
    await page.getByRole("button", { name: "Back to chat", exact: true }).click();
    await expect(page.locator('[data-slot="cake-chat-group"]').getByRole("img")).toHaveCount(0);
    await expect
      .poll(async () => JSON.parse(await readFile(document, "utf8")).data.unreadSessionIds)
      .not.toContain(CAKE_CHAT_SESSION_ID);
    await expect(page.getByText(/^Coordinator reply\./).first()).toBeVisible();
    await expect(page.locator("[data-context-state]")).toHaveCount(0);
    input = page.getByRole("combobox", { name: "Message Cake Chat" });
    await input.click();
    await expect(input).toBeFocused();
    await input.pressSequentially("A new independent question");
    await expect(input).toHaveValue("A new independent question");
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect.poll(() => requests.length).toBe(2);
    expect(JSON.stringify(requests[1])).toContain("Always create a worktree for coding sessions.");
    expect(JSON.stringify(requests[1])).not.toContain(
      "Detailed task context. Detailed task context.",
    );
    expect(await readFile(projectFile, "utf8")).toBe(projectHistory);
  } finally {
    releaseFirstReply?.();
    await app.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
