import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { _electron as electron } from "../../scripts/queued-electron.mjs";
import { seedSideChatTabs, sideChatTabTitles } from "../fixtures/side-chat-tabs";

const repository = resolve(import.meta.dirname, "../..");

test("capture focuses its composer without collapsing a visible human Side Chat or tool split", async () => {
  test.setTimeout(120_000);
  const temporary = await mkdtemp(join(tmpdir(), "cake-capture-split-return-"));
  const cakeHome = join(temporary, "cake");
  const userData = join(temporary, "user-data");
  const project = join(temporary, "project");
  await seedSideChatTabs(cakeHome, userData, project, "light", 1);
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
    // Fake only desktop pixels/shortcut registration, not overlay, routing, layout or focus.
    await app.evaluate(
      ({ desktopCapturer, nativeImage, screen, systemPreferences, globalShortcut }) => {
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
        globalShortcut.register = (_accelerator, callback) => {
          Reflect.set(globalThis, "splitReturnCaptureShortcut", callback);
          return true;
        };
        globalShortcut.unregister = () => {};
      },
    );
    const page = await app.firstWindow();
    await expect(page).toHaveURL(/\/out\/renderer\/index\.html/);
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setContentSize(1800, 1000),
    );
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page
      .getByRole("button", { name: "Open Project Chat for Tab fixture", exact: true })
      .click();
    const composer = page.getByRole("combobox", { name: "Message Project Chat", exact: true });
    await composer.fill("Keep parent draft");
    const openSideChat = async () => {
      await page.getByRole("button", { name: "Side chats, 1 open", exact: true }).click();
      await page
        .getByRole("dialog", { name: "Open side chats" })
        .getByRole("button", { name: sideChatTabTitles[0], exact: true })
        .click();
    };
    await openSideChat();
    const sideChat = page.getByRole("complementary", { name: sideChatTabTitles[0], exact: true });
    const sideInput = sideChat.getByRole("combobox");
    const layout = page.locator('[data-slot="side-chat-layout"]');
    await expect(layout).toHaveAttribute("data-presentation", "side-by-side");
    await sideInput.fill("Keep human Side Chat draft");
    const captures = join(repository, ".visual-captures");
    await mkdir(captures, { recursive: true });
    await page.screenshot({ path: join(captures, "capture-split-primary-before.png") });
    let attachments = 0;
    const capture = async () => {
      await expect
        .poll(() =>
          app.evaluate(() => typeof Reflect.get(globalThis, "splitReturnCaptureShortcut")),
        )
        .toBe("function");
      // Browser mode's workspace page is also a window; wait for the capture overlay itself.
      const opened = app.waitForEvent("window", {
        predicate: (window) => new URL(window.url()).searchParams.has("screenCapture"),
      });
      await app.evaluate(() => Reflect.get(globalThis, "splitReturnCaptureShortcut")());
      const overlay = await opened;
      await expect(overlay.getByRole("toolbar", { name: "Screen capture tools" })).toBeVisible();
      await overlay.getByRole("button", { name: "Attach full display", exact: true }).click();
      await expect(composer).toBeFocused();
      await expect(composer).toHaveValue("Keep parent draft");
      await expect(
        page.getByRole("button", { name: /^View [a-z0-9]{3}\.png enlarged$/ }),
      ).toHaveCount(++attachments);
    };
    await capture();
    await expect(layout).toHaveAttribute("data-presentation", "side-by-side");
    await expect(sideInput).toHaveValue("Keep human Side Chat draft");
    await page.screenshot({ path: join(captures, "capture-split-primary-after.png") });

    // The destination composer can also live in the tool's secondary companion.
    await page.getByRole("button", { name: "Browser", exact: true }).click();
    const browser = page.getByRole("region", { name: "Browser workspace", exact: true });
    await expect(browser).toBeVisible();
    const companionResize = page.getByRole("separator", {
      name: "Resize current session sidebar",
      exact: true,
    });
    await companionResize.press("Home");
    for (let step = 0; step < 14; step++) await companionResize.press("Shift+ArrowLeft");
    await expect(layout).toHaveAttribute("data-presentation", "side-by-side");
    await capture();
    await expect(browser).toBeVisible();
    await expect(sideInput).toHaveValue("Keep human Side Chat draft");
    await page.screenshot({ path: join(captures, "capture-split-secondary-after.png") });

    // Revealing a hidden companion must measure its newly mounted split, not dismiss it blindly.
    await page
      .getByRole("group", { name: "Companion content", exact: true })
      .getByRole("button", { name: "Todos", exact: true })
      .click();
    await expect(composer).toHaveCount(0);
    await capture();
    await expect(layout).toHaveAttribute("data-presentation", "side-by-side");
    await expect(sideInput).toHaveValue("Keep human Side Chat draft");
    await page.locator('[data-slot="shell-workspace-toggle"]').click();
    await expect(composer).toHaveCount(0);
    await capture();
    await expect(sideInput).toHaveValue("Keep human Side Chat draft");

    // At replacement width, hiding the accessory is deliberate: otherwise the attachment is unreachable.
    await page
      .getByRole("separator", { name: "Resize current session sidebar", exact: true })
      .press("Home");
    await expect(layout).toHaveAttribute("data-presentation", "replacement");
    await expect(composer).not.toBeVisible();
    await capture();
    await expect(sideChat).toHaveCount(0);
    await expect(browser).toBeVisible();
    await page.screenshot({ path: join(captures, "capture-hidden-composer-after.png") });
    await openSideChat();
    await expect(sideInput).toHaveValue("Keep human Side Chat draft");
    // Dismissing the pane did not delete/resolve the chat; its existing draft is still editable.
    await sideInput.press("Meta+ArrowDown");
    await sideInput.pressSequentially(" retained");
    await expect(sideInput).toHaveValue("Keep human Side Chat draft retained");
    expect(errors).toEqual([]);
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
