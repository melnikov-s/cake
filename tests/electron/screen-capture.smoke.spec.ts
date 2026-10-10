import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test, type Page } from "@playwright/test";

const repositoryRoot = resolve(import.meta.dirname, "../..");

test("captures and annotates through the hidden native overlay into the existing chat draft", async () => {
  test.setTimeout(90_000);
  const temporaryRoot = await mkdtemp(join(tmpdir(), "cake-screen-capture-"));
  const userData = join(temporaryRoot, "user-data");
  const project = join(temporaryRoot, "project");
  const otherProject = join(temporaryRoot, "other-project");
  const cakeHome = join(temporaryRoot, "cake-home");
  await Promise.all([
    mkdir(userData, { recursive: true }),
    mkdir(project, { recursive: true }),
    mkdir(otherProject, { recursive: true }),
    mkdir(join(cakeHome, "state"), { recursive: true }),
  ]);
  await writeFile(
    join(userData, "window-state.json"),
    JSON.stringify({
      projectPath: project,
      recentProjectPaths: [project],
      draft: "",
      theme: "dark",
    }),
  );
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
        {
          path: otherProject,
          name: "Other Project",
          addedAt: new Date(0).toISOString(),
          lastOpenedAt: new Date(0).toISOString(),
        },
      ],
      trustedProjectPaths: [project, otherProject],
    }),
  );
  const application = await electron.launch({
    args: [repositoryRoot],
    cwd: repositoryRoot,
    env: {
      ...process.env,
      CAKE_ELECTRON_SMOKE: "1",
      CAKE_ELECTRON_USER_DATA: userData,
      CAKE_HOME: cakeHome,
    },
  });
  try {
    // Fake only native capture/registration. Keep the real RPC, native window, editing UI,
    // compositor, destination Store, and Chat. Never capture this user's actual desktop.
    const original = await application.evaluate(
      ({ desktopCapturer, nativeImage, screen, systemPreferences, globalShortcut }) => {
        const bitmap = Buffer.alloc(2400 * 1200 * 4);
        for (let index = 0; index < bitmap.length; index += 4) {
          bitmap[index] = 90;
          bitmap[index + 1] = 100;
          bitmap[index + 2] = 110;
          bitmap[index + 3] = 255;
        }
        const image = nativeImage.createFromBitmap(bitmap, { width: 2400, height: 1200 });
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
          Reflect.set(globalThis, "captureShortcut", callback);
          return true;
        };
        globalShortcut.unregister = () => {};
        return image.toPNG().toString("base64");
      },
    );
    const page = await application.firstWindow();
    const composer = page.getByRole("combobox", { name: "Message", exact: true });
    await expect(composer).toBeVisible({ timeout: 20_000 });
    await composer.click();
    await page.keyboard.type("Keep this draft");
    await expect(composer).toBeFocused();
    await expect(composer).toHaveValue("Keep this draft");
    const settings = page.getByRole("complementary").getByLabel("Open settings", { exact: true });
    await settings.click();
    await page.getByRole("button", { name: /^Screen Capture/ }).click();
    await page.getByLabel("Maximum image dimension").selectOption("1024");
    const shortcut = page.getByRole("button", { name: "Screen capture shortcut", exact: true });
    await shortcut.click();
    await page.keyboard.press(process.platform === "darwin" ? "Meta+Shift+7" : "Control+Shift+7");
    await expect(shortcut).toContainText("7");
    await expect
      .poll(() => application.evaluate(() => typeof Reflect.get(globalThis, "captureShortcut")))
      .toBe("function");
    const begin = async (): Promise<Page> => {
      const opened = application.waitForEvent("window");
      await page.getByRole("button", { name: "Capture screenshot", exact: true }).click();
      const overlay = await opened;
      await expect(overlay.getByRole("toolbar", { name: "Screen capture tools" })).toBeVisible();
      await expect
        .poll(() =>
          overlay.locator("canvas").evaluate((canvas) => (canvas as HTMLCanvasElement).width),
        )
        .toBe(2400);
      expect(
        await application.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().every(
            (window) => !window.isVisible() && !window.isFocused(),
          ),
        ),
      ).toBe(true);
      return overlay;
    };
    let overlay = await begin();
    const originalDestination = await overlay
      .getByRole("combobox", { name: "Screenshot destination" })
      .inputValue();
    expect(originalDestination).not.toBe("new");
    const destination = overlay.getByRole("combobox", { name: "Screenshot destination" });
    await expect(destination.locator("option").first()).toHaveText("New session");
    await destination.selectOption("new");
    await overlay.getByRole("combobox", { name: "New session Project" }).selectOption(otherProject);
    await Promise.all([
      overlay.waitForEvent("close"),
      overlay.keyboard.press("Escape").catch((error: unknown) => {
        if (!overlay.isClosed()) throw error;
      }),
    ]);
    await expect.poll(() => application.windows().length).toBe(1);
    await page.getByRole("button", { name: "Back to chat" }).click();
    await expect(composer).toHaveValue("Keep this draft");
    await expect(page.getByRole("button", { name: /^View Screenshot-/ })).toHaveCount(0);

    // Invoke the registered global callback with Cake on its Settings surface: last chat wins.
    await settings.click();
    await page.getByRole("button", { name: /^Screen Capture/ }).click();
    const opened = application.waitForEvent("window");
    await application.evaluate(() => {
      const callback = Reflect.get(globalThis, "captureShortcut");
      if (typeof callback !== "function") throw new Error("Capture shortcut was not registered");
      callback();
    });
    overlay = await opened;
    await expect(overlay.getByRole("button", { name: "Attach full display" })).toBeEnabled();
    await expect(overlay.getByRole("combobox", { name: "Screenshot destination" })).toHaveValue(
      originalDestination,
    );
    await expect
      .poll(() =>
        overlay.locator("canvas").evaluate((canvas) => (canvas as HTMLCanvasElement).width),
      )
      .toBe(2400);
    await overlay.getByRole("button", { name: "Annotate", exact: true }).click();
    const bounds = (await overlay.locator("canvas").boundingBox())!;
    const start = { x: bounds.x + bounds.width * 0.25, y: bounds.y + bounds.height * 0.4 };
    const end = { x: bounds.x + bounds.width * 0.6, y: bounds.y + bounds.height * 0.65 };
    await overlay.mouse.move(start.x, start.y);
    await overlay.mouse.down();
    await overlay.mouse.move(end.x, end.y);
    await overlay.mouse.up();
    const label = overlay.getByRole("textbox", { name: "Arrow label" });
    await expect(label).toBeFocused();
    const labelBounds = (await label.boundingBox())!;
    expect(labelBounds.x).toBeCloseTo(end.x + 12, -1);
    expect(labelBounds.y).toBeCloseTo(end.y + 12, -1);
    await overlay.keyboard.type("Look here");
    await expect(label).toHaveValue("Look here");
    await overlay.keyboard.press("Enter");
    await expect(label).toHaveCount(0);
    // First Enter commits the label; the overlay is still present and can return to Crop.
    await overlay.getByRole("button", { name: "Crop", exact: true }).click();
    await expect(overlay.getByRole("button", { name: "Undo arrow" })).toBeEnabled();
    await overlay.keyboard.press("Enter");
    await expect.poll(() => application.windows().length).toBe(1);
    const preview = page.getByRole("button", { name: /^View Screenshot-/ });
    await expect(preview).toHaveCount(1);
    const source = await preview.locator("img").getAttribute("src");
    expect(source).not.toBe(`data:image/png;base64,${original}`);
    expect(
      await application.evaluate(
        ({ nativeImage }, data) => nativeImage.createFromDataURL(data).getSize(),
        source!,
      ),
    ).toEqual({ width: 1024, height: 512 });
    const pixels = await application.evaluate(({ nativeImage }, data) => {
      const image = nativeImage.createFromDataURL(data);
      const bitmap = image.toBitmap();
      const { width, height } = image.getSize();
      let annotated = 0;
      let chrome = 0;
      for (let index = 0; index < bitmap.length; index += 4) {
        if (
          bitmap[index] !== bitmap[0] ||
          bitmap[index + 1] !== bitmap[1] ||
          bitmap[index + 2] !== bitmap[2]
        ) {
          annotated += 1;
          if (index < width * Math.floor(height / 4) * 4) chrome += 1;
        }
      }
      return { annotated, chrome };
    }, source!);
    expect(pixels.annotated).toBeGreaterThan(100);
    expect(pixels.chrome).toBe(0);
    await expect(composer).toHaveValue("Keep this draft");
    await composer.click();
    await expect(composer).toBeFocused();
    await page.keyboard.type(" plus screenshot");
    await expect(composer).toHaveValue("Keep this draft plus screenshot");
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();

    await settings.click();
    overlay = await begin();
    const cropBounds = (await overlay.locator("canvas").boundingBox())!;
    await overlay.getByRole("button", { name: "Annotate", exact: true }).click();
    await overlay.mouse.move(
      cropBounds.x + cropBounds.width * 0.15,
      cropBounds.y + cropBounds.height * 0.5,
    );
    await overlay.mouse.down();
    await overlay.mouse.move(
      cropBounds.x + cropBounds.width * 0.3,
      cropBounds.y + cropBounds.height * 0.7,
    );
    await overlay.mouse.up();
    await overlay.keyboard.type("Crop this annotation");
    await overlay.keyboard.press("Enter");
    await overlay.getByRole("button", { name: "Crop", exact: true }).click();
    // Reverse drag includes the newly committed annotation and finishes immediately.
    await overlay.mouse.move(
      cropBounds.x + cropBounds.width * 0.35,
      cropBounds.y + cropBounds.height * 0.75,
    );
    await overlay.mouse.down();
    await overlay.mouse.move(
      cropBounds.x + cropBounds.width * 0.1,
      cropBounds.y + cropBounds.height * 0.35,
    );
    await overlay.mouse.up();
    await expect.poll(() => application.windows().length).toBe(1);
    await expect(preview).toHaveCount(2);
    const cropped = await preview.last().locator("img").getAttribute("src");
    const size = await application.evaluate(
      ({ nativeImage }, data) => nativeImage.createFromDataURL(data).getSize(),
      cropped!,
    );
    expect(size.width).toBeCloseTo(600, -1);
    expect(size.height).toBeCloseTo(480, -1);
    expect(
      await application.evaluate(({ nativeImage }, data) => {
        const bytes = nativeImage.createFromDataURL(data).toBitmap();
        for (let index = 0; index < bytes.length; index += 4) {
          if (
            bytes[index] !== bytes[0] ||
            bytes[index + 1] !== bytes[1] ||
            bytes[index + 2] !== bytes[2]
          )
            return true;
        }
        return false;
      }, cropped!),
    ).toBe(true);

    await settings.click();
    overlay = await begin();
    await overlay.getByRole("combobox", { name: "Screenshot destination" }).selectOption("new");
    const projectPicker = overlay.getByRole("combobox", { name: "New session Project" });
    await expect(projectPicker).toHaveValue(project);
    await projectPicker.selectOption(otherProject);
    await expect(projectPicker).toHaveValue(otherProject);
    await overlay.getByRole("button", { name: "Attach full display" }).click();
    await expect.poll(() => application.windows().length).toBe(1);
    await expect(preview).toHaveCount(1);
    await expect(composer).toHaveValue("");
    await composer.click();
    await expect(composer).toBeFocused();
    await page.keyboard.type("New Project screenshot");
    await expect(composer).toHaveValue("New Project screenshot");
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
    await settings.click();
    overlay = await begin();
    const picker = overlay.getByRole("combobox", { name: "Screenshot destination" });
    expect(await picker.inputValue()).not.toBe(originalDestination);
    await expect(picker.locator('optgroup[label="Other Project"] option')).toHaveCount(1);
    await picker.selectOption(originalDestination);
    await overlay.getByRole("button", { name: "Attach full display" }).click();
    await expect.poll(() => application.windows().length).toBe(1);
    await expect(preview).toHaveCount(3);
    await expect(composer).toHaveValue("Keep this draft plus screenshot");
  } finally {
    await application.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
