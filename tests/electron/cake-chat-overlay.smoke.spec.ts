import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";
import { defaultApplicationState } from "../../src/contracts/application/application-data";
import { store, windowStateDocument } from "../fixtures/window-state";
import { findVisualCaptureScenario } from "../../scripts/visual-capture/scenarios";

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

for (const voiceEnabled of [false, true]) {
  test(`drop-down Cake Chat focuses, shares conversation and reopens with voice ${voiceEnabled ? "on" : "off"}`, async () => {
    test.setTimeout(90_000);
    const root = await mkdtemp(join(tmpdir(), "cake-chat-overlay-smoke-"));
    const cakeHome = join(root, "cake-home");
    const userData = join(root, "user-data");
    await Promise.all([
      mkdir(join(cakeHome, "state"), { recursive: true }),
      mkdir(join(cakeHome, "pi"), { recursive: true }),
      mkdir(userData),
    ]);
    const voiceScenario = findVisualCaptureScenario("conversation-countdown")!;
    await voiceScenario.seed({ cakeHome, userData, project: join(root, "project") }, "dark");
    await writeFile(
      join(userData, "visual-dictation"),
      `#!${process.execPath}\nconst readline = require('node:readline');
process.stdout.write(JSON.stringify({ready:true})+'\\n');
readline.createInterface({input:process.stdin}).on('line', line => {
  const request = JSON.parse(line);
  process.stdout.write(JSON.stringify(request.operation === 'detectSpeech' ? {speech:true} : {text:'Let’s refine the voice conversation together.'})+'\\n');
});\n`,
    );
    await writeFile(
      join(userData, "window-state.json"),
      windowStateDocument({
        dictationStore: store({ enabled: voiceEnabled }),
      }),
    );
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
      args: [
        "--autoplay-policy=no-user-gesture-required",
        "--use-fake-device-for-media-stream",
        "--use-fake-ui-for-media-stream",
        repositoryRoot,
      ],
      cwd: repositoryRoot,
      env: {
        ...process.env,
        ...voiceScenario.environment?.({ cakeHome, userData, project: join(root, "project") }),
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

      for (const name of [/^\d+ artifacts$/, "Work log display options", "Inspect context"]) {
        await expect(main.getByRole("button", { name, exact: true })).toBeVisible();
      }

      // Replace only audio hardware; keep the real focus, dictation Store and recognizer path.
      await app.context().addInitScript(() => {
        if (!new URL(location.href).searchParams.has("cakeChatOverlay")) return;
        const source = new AudioContext();
        const stream = source.createMediaStreamDestination().stream;
        navigator.mediaDevices.getUserMedia = async () => stream;
        const WorkletNode = AudioWorkletNode;
        globalThis.AudioWorkletNode = class extends WorkletNode {
          constructor(context: BaseAudioContext, name: string, options?: AudioWorkletNodeOptions) {
            super(context, name, options);
            this.port.addEventListener("message", (event) => {
              if (event.isTrusted && event.data instanceof Float32Array)
                event.stopImmediatePropagation();
            });
            Reflect.set(window, "overlayDictationProcessor", this);
          }
        };
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

      for (const name of [/^\d+ artifacts$/, "Work log display options", "Inspect context"]) {
        await expect(overlay.getByRole("button", { name, exact: true })).toHaveCount(0);
      }
      await expect(input).toBeFocused();
      if (voiceEnabled) {
        await expect(
          overlay.getByRole("button", { name: "Mute dictation", exact: true }),
        ).toBeVisible();
        await expect(overlay.locator('[data-slot="dictation-indicator"]')).toHaveText("Listening");
        await overlay.evaluate(() => {
          const processor = Reflect.get(window, "overlayDictationProcessor") as AudioWorkletNode;
          processor.port.dispatchEvent(
            new MessageEvent("message", { data: new Float32Array(12800).fill(0.1) }),
          );
        });
        await expect(input).toHaveValue("Let’s refine the voice conversation together.");
        await input.fill("");
      }
      const nativeBounds = await app.evaluate(({ BrowserWindow, screen }) => {
        const window = BrowserWindow.getAllWindows().find((w) =>
          new URL(w.webContents.getURL()).searchParams.has("cakeChatOverlay"),
        )!;
        const workArea = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
        return { actual: window.getBounds(), workArea };
      });
      expect(nativeBounds.actual).toEqual({
        x: nativeBounds.workArea.x,
        y: nativeBounds.workArea.y,
        width: nativeBounds.workArea.width,
        height: Math.min(
          nativeBounds.workArea.height,
          Math.max(
            Math.min(360, nativeBounds.workArea.height),
            Math.round(nativeBounds.workArea.height * 0.45),
          ),
        ),
      });
      await input.pressSequentially("Hello from the drop-down");
      await expect(input).toHaveValue("Hello from the drop-down");
      await expect(overlay.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
      await overlay.getByRole("button", { name: "Send", exact: true }).click();
      await expect(overlay.getByText("Reply from the shared Cake Chat.")).toBeVisible({
        timeout: 20_000,
      });
      // Resizing the outer window must not stretch the shared reading/composing columns.
      for (const width of [1600, 1000, 600]) {
        await app.evaluate(({ BrowserWindow }, width) => {
          BrowserWindow.getAllWindows()
            .find((w) => new URL(w.webContents.getURL()).searchParams.has("cakeChatOverlay"))!
            .setContentSize(width, 500);
        }, width);
        await expect.poll(() => overlay.evaluate(() => innerWidth)).toBe(width);
        for (const [selector, maxWidth] of [
          [".workbench-composer", 884],
          ['[aria-label="Conversation"]', 816],
        ] as const) {
          const column = overlay.locator(selector);
          await expect
            .poll(() =>
              column.evaluate((element) => {
                const box = element.getBoundingClientRect();
                return Math.abs(box.x + box.width / 2 - innerWidth / 2);
              }),
            )
            .toBeLessThan(1);
          expect((await column.boundingBox())!.width).toBeLessThanOrEqual(maxWidth);
        }
      }
      // The main window observes the same live conversation rather than a copy.
      await expect(main.getByText("Hello from the drop-down")).toBeVisible();
      await expect(main.getByText("Reply from the shared Cake Chat.")).toBeVisible();

      // The crop button reuses the native screen capture and attaches to the overlay's draft.
      // Fake only the pixels; never capture the developer's real desktop.
      await app.evaluate(({ desktopCapturer, nativeImage, screen, systemPreferences }) => {
        const image = nativeImage.createFromBitmap(Buffer.alloc(64 * 32 * 4, 200), {
          width: 64,
          height: 32,
        });
        desktopCapturer.getSources = async () => [
          {
            id: "screen:fixture",
            name: "Fixture display",
            display_id: String(screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).id),
            thumbnail: image,
            appIcon: null,
          },
        ];
        systemPreferences.getMediaAccessStatus = () => "granted";
      });
      const capturing = app.waitForEvent("window");
      await overlay.getByRole("button", { name: "Capture screenshot" }).click();
      const capture = await capturing;
      await expect(capture.getByRole("toolbar", { name: "Screen capture tools" })).toBeVisible();
      await expect(capture.getByRole("button", { name: "Screenshot destination" })).toContainText(
        "Cake Chat",
      );
      await Promise.all([capture.waitForEvent("close"), capture.keyboard.press("Enter")]);
      await expect(overlay.getByRole("button", { name: /^View Screenshot-/ })).toBeVisible();
      await expect(main.getByRole("button", { name: /^View Screenshot-/ })).toHaveCount(0);

      await overlay.getByRole("button", { name: "Close drop-down Cake Chat" }).click();
      // Toggling again reuses the hidden overlay renderer instead of creating another window.
      await clickMenuItem(app, "Drop-down Cake Chat");
      await expect(input).toBeFocused();
      // Exercise the native focus event without claiming desktop focus.
      await overlay.getByRole("button", { name: "Capture screenshot", exact: true }).focus();
      await overlay.evaluate(() => window.dispatchEvent(new Event("focus")));
      await expect(input).toBeFocused();
      await input.pressSequentially("Retained on reopen");
      await expect(input).toHaveValue("Retained on reopen");
      await expect(overlay.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
      await clickMenuItem(app, "Drop-down Cake Chat");
      await clickMenuItem(app, "Drop-down Cake Chat");
      await expect(input).toBeFocused();
      await expect(input).toHaveValue("Retained on reopen");
      if (voiceEnabled)
        await expect(
          overlay.getByRole("button", { name: "Mute dictation", exact: true }),
        ).toBeVisible();
      expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(
        2,
      );
    } finally {
      await app.close();
      server.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}
