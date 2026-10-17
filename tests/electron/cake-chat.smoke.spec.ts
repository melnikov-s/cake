import { createServer } from "node:http";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";
import { CAKE_CHAT_SESSION_ID } from "../../src/contracts/cake-chats/cake-chat-identity";
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

test("permanent Cake Chat retains its input, history and settings across restart", async () => {
  test.setTimeout(90_000);
  const root = await mkdtemp(join(tmpdir(), "cake-chat-smoke-"));
  const cakeHome = join(root, "cake-home");
  const userData = join(root, "user-data");
  const document = join(cakeHome, "state", "application.json");
  await Promise.all([
    mkdir(join(cakeHome, "state"), { recursive: true }),
    mkdir(join(cakeHome, "pi"), { recursive: true }),
    mkdir(userData),
  ]);
  const requests: unknown[] = [];
  const requestBodies: string[] = [];
  const summaryBodies: string[] = [];
  let releaseFirstReply: (() => void) | undefined;
  const firstReplyGate = new Promise<void>((resolve) => {
    releaseFirstReply = resolve;
  });
  const summaryGate = Promise.withResolvers<void>();
  let stalledSummaries = 0;
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const parsed: unknown = JSON.parse(body);
    const summary = JSON.stringify(parsed).includes("You write the memory of Cake Chat");
    if (summary) summaryBodies.push(body);
    if (!summary) {
      requests.push(parsed);
      requestBodies.push(body);
      if (requests.length <= 2) await firstReplyGate;
    } else if (requests.length >= 3) {
      stalledSummaries += 1;
      await summaryGate.promise;
    }
    const text = summary
      ? "talk: coordinated project work; user asked about priorities"
      : `Coordinator reply. ${"Detailed task context. ".repeat(requests.length >= 3 ? 1000 : 50)}`;
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
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.getByRole("button", { name: "Cake Chat", exact: true }).click();
    let input = page.getByRole("combobox", { name: "Message Cake Chat" });
    await expect(input).toBeVisible();
    const inspectButton = page.getByRole("button", { name: "Inspect context", exact: true });
    await expect(inspectButton).toBeVisible();
    const inspectBounds = await inspectButton.boundingBox();
    expect(inspectBounds!.x).toBeGreaterThan(900);
    expect(inspectBounds!.y).toBeLessThan(70);
    await inspectButton.click();
    await expect(page.getByText("No captured context yet.", { exact: true })).toBeVisible();
    expect(requests).toHaveLength(0);
    await expect(page.getByRole("button", { name: "Close", exact: true })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(inspectButton).toBeFocused();
    // An empty composer starts at the frame's normal inset, without a reserved header row.
    const inputInset = await input.evaluate((element) => {
      const frame = element.closest("form")!;
      const style = getComputedStyle(frame);
      return {
        top: element.getBoundingClientRect().top - frame.getBoundingClientRect().top,
        inset: parseFloat(style.borderTopWidth) + parseFloat(style.paddingTop),
      };
    });
    expect(inputInset.top).toBe(inputInset.inset);
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
    const imageTile = page.getByRole("button", { name: "View pixel.png enlarged", exact: true });
    await expect(imageTile).toBeVisible();
    const thumbnail = imageTile.getByRole("img", { name: "pixel.png", exact: true });
    await expect(thumbnail).toBeVisible();
    await expect(thumbnail).toHaveAttribute("src", `data:image/png;base64,${privateImage}`);
    await expect
      .poll(() => thumbnail.evaluate((image: HTMLImageElement) => image.naturalWidth))
      .toBe(1);
    const tiles = page.locator('.workbench-composer [data-slot="attachment-tile"]');
    await expect(tiles).toHaveCount(2);
    const geometry = await tiles.evaluateAll((elements) =>
      elements.map((element) => {
        const tile = element.getBoundingClientRect();
        const remove = element.querySelector('[aria-label^="Remove "]')?.getBoundingClientRect();
        return {
          width: tile.width,
          height: tile.height,
          top: tile.top,
          removeTop: remove ? remove.top - tile.top : null,
          removeRight: remove ? tile.right - remove.right : null,
        };
      }),
    );
    expect(geometry).toEqual(Array.from({ length: 2 }, () => geometry[0]));
    expect(geometry[0]).toMatchObject({
      width: 192,
      height: 80,
      removeTop: 5,
      removeRight: 5,
    });
    // Pasted text keeps its label; image tiles render the actual pixels instead.
    await expect(pastedChip.locator('[data-slot="attachment-label"]')).toContainText("Pasted text");
    // The thumbnail still opens the original preview without changing model access.
    await imageTile.click();
    const fullscreen = page.getByRole("dialog", { name: "pixel.png", exact: true });
    await expect(fullscreen.getByRole("img", { name: "pixel.png", exact: true })).toHaveAttribute(
      "src",
      `data:image/png;base64,${privateImage}`,
    );
    await page.keyboard.press("Escape");
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
    // No headers or response output have arrived: Stop must interrupt the request,
    // settle Churning, and leave the composer usable without releasing the server.
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await expect(page.getByLabel("Churning in progress")).toHaveCount(0);
    await expect(coordinator.getByRole("img", { name: "Running" })).toHaveCount(0);
    await input.click();
    await expect(input).toBeFocused();
    await input.pressSequentially("Discuss my priorities again");
    await expect(input).toHaveValue("Discuss my priorities again");
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect.poll(() => requests.length).toBe(2);
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
    for (let index = 0; index < 6; index += 1) {
      await input.fill(`Cancel queued ${index}`);
      await page.getByRole("button", { name: "Send", exact: true }).click();
    }
    const queue = page.getByRole("list", { name: "Queued prompts" });
    await expect(queue.getByRole("listitem")).toHaveCount(6);
    for (let index = 0; index < 6; index += 1) {
      await page
        .getByRole("button", { name: `Cancel queued message: Cancel queued ${index}`, exact: true })
        .click();
      await expect(queue.getByRole("listitem")).toHaveCount(5 - index);
    }
    await page.getByRole("button", { name: "0 artifacts", exact: true }).click();
    await page.getByRole("button", { name: "Browse all artifacts", exact: true }).click();
    await expect(page.getByLabel("Search artifact library")).toBeVisible();
    await page.getByRole("button", { name: "Close all artifacts", exact: true }).click();
    await expect(page.locator('[data-slot="workspace"]')).toHaveAttribute(
      "data-session-id",
      CAKE_CHAT_SESSION_ID,
    );
    await expect(input).toBeVisible();
    // Inspect the in-flight coordinator call before its reply starts background summaries.
    await inspectButton.click();
    const contextDialog = page.getByRole("dialog", { name: "Context", exact: true });
    await expect(contextDialog).toContainText("Discuss my priorities again");
    await expect(page.getByRole("button", { name: "Close", exact: true })).toBeFocused();
    await page.evaluate(() => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: async (text: string) => {
            Reflect.set(window, "capturedContextRaw", text);
          },
        },
      });
    });
    const copyContext = page.getByRole("button", { name: "Copy raw context", exact: true });
    await expect(copyContext.locator("svg")).toHaveCount(1);
    await copyContext.focus();
    await expect(copyContext).toBeFocused();
    const requestCount = requests.length;
    await page.keyboard.press("Enter");
    await expect(contextDialog.getByRole("status")).toHaveText("Raw context copied");
    expect(await page.evaluate(() => Reflect.get(window, "capturedContextRaw"))).toBe(
      requestBodies.at(-1),
    );
    expect(requests).toHaveLength(requestCount);
    await page.keyboard.press("Escape");
    await expect(inspectButton).toBeFocused();
    await page.getByRole("button", { name: "0 artifacts", exact: true }).click();
    await page.getByRole("button", { name: "Browse all artifacts", exact: true }).click();
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
    expect(summaryBodies.length).toBeGreaterThan(0);
    await inspectButton.click();
    // The newest call is now the memory summary: there is no selection step.
    await expect(contextDialog).toContainText("You write the memory of Cake Chat");
    await copyContext.click();
    await expect(contextDialog.getByRole("status")).toHaveText("Raw context copied");
    expect(await page.evaluate(() => Reflect.get(window, "capturedContextRaw"))).toBe(
      summaryBodies.at(-1),
    );
    await page.getByRole("button", { name: "Close", exact: true }).click();

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
    await expect.poll(() => requests.length).toBe(3);
    expect(JSON.stringify(requests[2])).toContain("Always create a worktree for coding sessions.");
    expect(JSON.stringify(requests[2])).not.toContain(
      "Detailed task context. Detailed task context.",
    );

    // The reply exceeds the memory budget, so background indexing starts a slow
    // summary. The next turn stalls before its provider request, not in streaming.
    await expect.poll(() => stalledSummaries).toBeGreaterThan(0);
    await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
    await input.fill("Stop while waiting for memory");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect
      .poll(async () => {
        const storage = await openNodeSqliteStorage(database);
        try {
          const page = await storage.scanEntries(
            { conversationId: ROOT_CONVERSATION_ID, order: "descending" },
            16,
            undefined,
            BACKGROUND_CONTEXT,
          );
          return JSON.stringify(page.items.find((entry) => entry.kind === "pi.reset")?.model);
        } finally {
          await storage.close(BACKGROUND_CONTEXT);
        }
      })
      .toContain("Stop while waiting for memory");
    expect(requests).toHaveLength(3);
    await expect(page.getByLabel("Churning in progress")).toBeVisible();
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await expect(page.getByLabel("Churning in progress")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
    expect(requests).toHaveLength(3);
    summaryGate.resolve();
    await input.click();
    await expect(input).toBeFocused();
    await input.pressSequentially("Retry after stopping memory wait");
    await expect(input).toHaveValue("Retry after stopping memory wait");
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect.poll(() => requests.length).toBe(4);
    await expect(page.getByLabel("Churning in progress")).toHaveCount(0);
  } finally {
    releaseFirstReply?.();
    summaryGate.resolve();
    await app.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
