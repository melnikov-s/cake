import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { _electron as electron } from "../../scripts/queued-electron.mjs";
import { seedSideChatTabs } from "../fixtures/side-chat-tabs";

const repository = resolve(import.meta.dirname, "../..");

test("capture initializes across old routing IPC and recovers from invalid snapshots", async () => {
  test.setTimeout(120_000);
  const temporary = await mkdtemp(join(tmpdir(), "cake-capture-routing-"));
  const cakeHome = join(temporary, "cake");
  const userData = join(temporary, "user-data");
  const project = join(temporary, "project");
  await seedSideChatTabs(cakeHome, userData, project, "dark", 1);
  const app = await electron.launch({
    args: [repository],
    cwd: repository,
    env: {
      ...process.env,
      CAKE_ELECTRON_SMOKE: "1",
      ELECTRON_RENDERER_URL: "",
      CAKE_HOME: cakeHome,
      CAKE_ELECTRON_USER_DATA: userData,
      PI_CODING_AGENT_DIR: join(cakeHome, "pi"),
      PI_CODING_AGENT_SESSION_DIR: "",
    },
  });
  try {
    // Keep real native windows, preload, RPC codecs and capture command. Simulate only
    // the old server's missing key at its actual outgoing IPC boundary below.
    await app.evaluate(({ app, globalShortcut }) => {
      globalShortcut.register = (_accelerator, callback) => {
        Reflect.set(globalThis, "routingCaptureShortcut", callback);
        return true;
      };
      globalShortcut.unregister = () => {};
      Reflect.set(globalThis, "routingCaptureMode", "normal");
      app.on("browser-window-created", (_event, window) => {
        const contents = window.webContents;
        const send = contents.send.bind(contents);
        contents.send = (channel, ...args) => {
          const response: unknown = args[0];
          if (channel === "cake:rpc:response" && response && typeof response === "object") {
            const exit: unknown = Reflect.get(response, "exit");
            if (exit && typeof exit === "object") {
              const value: unknown = Reflect.get(exit, "value");
              if (value && typeof value === "object") {
                const routing: unknown = Reflect.get(value, "routing");
                if (routing && typeof routing === "object") {
                  const mode: unknown = Reflect.get(globalThis, "routingCaptureMode");
                  const dictation: unknown = Reflect.get(routing, "dictation");
                  if (mode === "legacy" && dictation && typeof dictation === "object")
                    Reflect.deleteProperty(dictation, "muted");
                  if (mode === "invalid") Reflect.deleteProperty(value, "width");
                }
              }
            }
          }
          send(channel, ...args);
        };
      });
    });
    const page = await app.firstWindow();
    await expect(page).toHaveURL(/\/out\/renderer\/index\.html/);
    await page
      .getByRole("button", { name: "Open Project Chat for Tab fixture", exact: true })
      .click();
    const composer = page.getByRole("combobox", { name: "Message Project Chat", exact: true });
    await composer.fill("Preserve this capture draft");
    await expect
      .poll(() => app.evaluate(() => typeof Reflect.get(globalThis, "routingCaptureShortcut")))
      .toBe("function");
    const start = () => app.evaluate(() => Reflect.get(globalThis, "routingCaptureShortcut")());
    const screenshots = join(repository, ".visual-captures");
    await mkdir(screenshots, { recursive: true });

    // Real desktop pixels are opt-in evidence, never an ordinary smoke-test side effect.
    if (process.env.CAKE_CAPTURE_NATIVE_EVIDENCE === "1") {
      const permission = await app.evaluate(({ systemPreferences }) =>
        process.platform === "darwin"
          ? systemPreferences.getMediaAccessStatus("screen")
          : "granted",
      );
      test.info().annotations.push({ type: "native-screen-permission", description: permission });
      console.log(`Native screen capture permission: ${permission}`);
      if (permission === "granted") {
        const opened = app.waitForEvent("window");
        await start();
        const overlay = await opened;
        await expect(
          overlay.getByRole("button", { name: "Attach full display", exact: true }),
        ).toBeEnabled();
        await expect
          .poll(() =>
            overlay.locator("canvas").evaluate((canvas) => {
              if (!(canvas instanceof HTMLCanvasElement)) throw new Error("Missing capture canvas");
              return canvas.width;
            }),
          )
          .toBeGreaterThan(0);
        await overlay.screenshot({ path: join(screenshots, "capture-native-initialized.png") });
        await overlay.getByRole("button", { name: "Cancel", exact: true }).click();
        await expect.poll(() => app.windows().length).toBe(1);
      } else if (permission === "denied") {
        await start();
        await expect(page.getByText(/Allow Cake in System Settings/)).toBeVisible();
        expect(app.windows()).toHaveLength(1);
      }
    }
    // Do not request a new OS permission or focus any test window. With permission
    // unavailable, synthetic pixels still exercise the complete capture-start IPC.
    await app.evaluate(({ desktopCapturer, nativeImage, screen, systemPreferences }) => {
      const image = nativeImage.createFromBitmap(Buffer.alloc(800 * 600 * 4, 255), {
        width: 800,
        height: 600,
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
    let retried = false;
    for (const mode of ["legacy", "invalid", "invalid", "normal"] as const) {
      await app.evaluate(
        (_electron, mode) => Reflect.set(globalThis, "routingCaptureMode", mode),
        mode,
      );
      const opened = app.waitForEvent("window");
      await start();
      const overlay = await opened;
      await expect(overlay).toHaveURL(/\/out\/renderer\/index\.html\?screenCapture=1/);
      if (mode === "invalid") {
        await expect(overlay.getByRole("alert")).toContainText(
          "Screen capture could not initialize",
        );
        await expect(overlay.getByRole("alert")).toContainText("width");
        await overlay.screenshot({ path: join(screenshots, "capture-initialization-error.png") });
        if (retried) {
          await overlay.keyboard.press("Escape").catch((error: unknown) => {
            if (!overlay.isClosed()) throw error;
          });
          await expect.poll(() => app.windows().length).toBe(1);
          continue;
        }
        await app.evaluate(() => Reflect.set(globalThis, "routingCaptureMode", "normal"));
        await overlay.getByRole("button", { name: "Retry", exact: true }).click();
        retried = true;
      }
      await expect(
        overlay.getByRole("button", { name: "Attach full display", exact: true }),
      ).toBeEnabled();
      await expect
        .poll(() =>
          overlay.locator("canvas").evaluate((canvas) => {
            if (!(canvas instanceof HTMLCanvasElement)) throw new Error("Missing capture canvas");
            return canvas.width;
          }),
        )
        .toBe(800);
      await overlay.screenshot({
        path: join(screenshots, `capture-routing-${mode}-initialized.png`),
      });
      await overlay.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect.poll(() => app.windows().length).toBe(1);
      await expect(composer).toHaveValue("Preserve this capture draft");
    }
    expect(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().every((window) => !window.isVisible()),
      ),
    ).toBe(true);
  } finally {
    await app.close();
    await rm(temporary, { recursive: true, force: true });
  }
});
