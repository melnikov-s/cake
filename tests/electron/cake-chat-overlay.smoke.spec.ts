import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";
import { defaultApplicationState } from "../../src/contracts/application/application-data";

const repositoryRoot = resolve(import.meta.dirname, "../..");

/** Clicks a native application-menu item by label, exactly as the menu handler receives it. */
async function clickMenuItem(app: ElectronApplication, label: string) {
  await app.evaluate(({ Menu }, selected) => {
    const item = Menu.getApplicationMenu()
      ?.items.flatMap((entry) => entry.submenu?.items ?? [])
      .find((entry) => entry.label === selected);
    if (!item) throw new Error(`Missing menu item ${selected}`);
    Reflect.apply(item.click, item, [item, undefined, { triggeredByAccelerator: false }]);
  }, label);
}

test("drop-down Cake Chat shows the live shared conversation and puts itself away", async () => {
  test.setTimeout(90_000);
  const root = await mkdtemp(join(tmpdir(), "cake-chat-overlay-smoke-"));
  const cakeHome = join(root, "cake-home");
  const userData = join(root, "user-data");
  await Promise.all([
    mkdir(join(cakeHome, "state"), { recursive: true }),
    mkdir(join(cakeHome, "pi"), { recursive: true }),
    mkdir(userData),
  ]);
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const summary = body.includes("You write the memory of Cake Chat");
    const text = summary ? "talk: overlay greeting" : "Reply from the shared Cake Chat.";
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
    join(cakeHome, "state", "application.json"),
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
  const app = await electron.launch({
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
  try {
    const main = await app.firstWindow();
    await main.setViewportSize({ width: 1280, height: 900 });
    await main.getByRole("button", { name: "Cake Chat", exact: true }).click();
    await expect(main.getByRole("combobox", { name: "Message Cake Chat" })).toBeVisible({
      timeout: 20_000,
    });

    // Smoke runs never claim system-wide keys, so drive the same toggle from the Window menu.
    const opened = app.waitForEvent("window");
    await clickMenuItem(app, "Drop-down Cake Chat");
    const overlay = await opened;
    expect(new URL(overlay.url()).searchParams.get("cakeChatOverlay")).toBe("1");
    const input = overlay.getByRole("combobox", { name: "Message Cake Chat" });
    await expect(input).toBeVisible({ timeout: 20_000 });
    // Overlay chrome replaces the main window's sidebar and terminal controls.
    await expect(overlay.getByRole("button", { name: "Toggle sidebar" })).toHaveCount(0);
    await expect(overlay.getByRole("button", { name: "Terminal" })).toHaveCount(0);

    await input.click();
    await input.pressSequentially("Hello from the drop-down");
    await overlay.getByRole("button", { name: "Send", exact: true }).click();
    await expect(overlay.getByText("Reply from the shared Cake Chat.")).toBeVisible({
      timeout: 20_000,
    });
    // The main window observes the same live conversation rather than a copy.
    await expect(main.getByText("Hello from the drop-down")).toBeVisible();
    await expect(main.getByText("Reply from the shared Cake Chat.")).toBeVisible();

    await overlay.getByRole("button", { name: "Close drop-down Cake Chat" }).click();
    // Toggling again reuses the hidden overlay renderer instead of creating another window.
    await clickMenuItem(app, "Drop-down Cake Chat");
    await expect(input).toBeVisible();
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(2);
  } finally {
    await app.close();
    server.close();
    await rm(root, { recursive: true, force: true });
  }
});
