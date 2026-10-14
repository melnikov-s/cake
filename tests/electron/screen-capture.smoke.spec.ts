import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test, type Page } from "@playwright/test";
import { windowState } from "../fixtures/window-state";

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
  await writeFile(join(userData, "window-state.json"), windowState({ project, theme: "dark" }));
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
      ({ desktopCapturer, nativeImage, screen, systemPreferences, globalShortcut, dialog }) => {
        const failures: string[] = [];
        const dialogs: string[] = [];
        // Record regressions without opening a native error dialog on the user's desktop.
        process.on("uncaughtException", (error) => failures.push(error.message));
        dialog.showErrorBox = (title, content) => dialogs.push(`${title}: ${content}`);
        Object.assign(globalThis, { captureFailures: failures, captureDialogs: dialogs });
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
    const toolbar = overlay.getByRole("toolbar", { name: "Screen capture tools" });
    const toolbarBounds = (await toolbar.boundingBox())!;
    expect(toolbarBounds.width).toBeLessThan(500);
    expect(toolbarBounds.height).toBeLessThan(50);
    // Empty space on BOTH sides at the toolbar's height reaches the capture canvas.
    for (const x of [toolbarBounds.x - 20, toolbarBounds.x + toolbarBounds.width + 20]) {
      expect(
        await overlay.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.tagName, {
          x,
          y: toolbarBounds.y + 20,
        }),
      ).toBe("CANVAS");
    }
    const grip = overlay.getByRole("button", { name: "Move capture toolbar" });
    const gripBounds = (await grip.boundingBox())!;
    await overlay.mouse.move(gripBounds.x + 15, gripBounds.y + 15);
    await overlay.mouse.down();
    await overlay.mouse.move(gripBounds.x + 95, gripBounds.y + 95);
    await overlay.mouse.up();
    const movedBounds = (await toolbar.boundingBox())!;
    expect(movedBounds.x).toBeCloseTo(toolbarBounds.x + 80, 0);
    expect(movedBounds.y).toBeCloseTo(toolbarBounds.y + 80, 0);
    expect(
      await overlay.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.tagName, {
        x: toolbarBounds.x + 20,
        y: toolbarBounds.y + 20,
      }),
    ).toBe("CANVAS");
    const destination = overlay.getByRole("button", { name: "Screenshot destination" });
    await destination.click();
    const popup = overlay.getByRole("dialog", { name: "Screenshot destination" });
    await expect(popup.locator("button").first()).toHaveText("New chat");
    const originalDestination = await popup
      .locator('[data-navigation-active="true"][data-session-id]')
      .getAttribute("data-session-id");
    expect(originalDestination).toBeTruthy();
    await overlay.keyboard.press("Escape");
    await expect(popup).toHaveCount(0);
    await expect(overlay.getByRole("toolbar")).toBeVisible();
    await destination.click();
    await popup.getByRole("button", { name: "New chat", exact: true }).click();
    await popup.getByRole("button", { name: "New chat in Other Project", exact: true }).click();
    await expect(destination).toHaveText("New chat · Other Project");
    // Clamp a drag past the viewport edges; the destination popup flips above the strip.
    const currentGrip = (await grip.boundingBox())!;
    const viewport = await overlay.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    await overlay.mouse.move(currentGrip.x + 15, currentGrip.y + 15);
    await overlay.mouse.down();
    await overlay.mouse.move(viewport.width + 100, viewport.height + 100);
    await overlay.mouse.up();
    const edgeToolbar = (await toolbar.boundingBox())!;
    expect(edgeToolbar.x + edgeToolbar.width).toBeLessThanOrEqual(viewport.width - 7);
    expect(edgeToolbar.y + edgeToolbar.height).toBeLessThanOrEqual(viewport.height - 7);
    await destination.click();
    const popupBounds = (await popup.boundingBox())!;
    expect(popupBounds.y + popupBounds.height).toBeLessThanOrEqual(edgeToolbar.y);
    expect(popupBounds.x + popupBounds.width).toBeLessThanOrEqual(viewport.width - 7);
    await overlay.keyboard.press("Escape");
    await expect(popup).toHaveCount(0);
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
    // Reproduce launchers whose diagnostic readers have disconnected. Capture teardown can
    // emit Node warnings; those writes must not become an uncaught EPIPE desktop dialog.
    for (const channel of ["stdout", "stderr"] as const) {
      const reader = application.process()[channel];
      if (!reader) throw new Error(`Electron ${channel} is not piped`);
      reader.destroy();
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const reopening = application.waitForEvent("window");
      await application.evaluate(() => {
        const callback = Reflect.get(globalThis, "captureShortcut");
        if (typeof callback !== "function") throw new Error("Capture shortcut was not registered");
        callback();
      });
      const cancelledOverlay = await reopening;
      await expect(
        cancelledOverlay.getByRole("toolbar", { name: "Screen capture tools" }),
      ).toBeVisible();
      await cancelledOverlay.getByRole("button", { name: "Annotate", exact: true }).click();
      const bounds = (await cancelledOverlay.locator("canvas").boundingBox())!;
      await cancelledOverlay.mouse.move(bounds.width * 0.2, bounds.height * 0.4);
      await cancelledOverlay.mouse.down();
      await cancelledOverlay.mouse.move(bounds.width * 0.5, bounds.height * 0.6);
      await cancelledOverlay.mouse.up();
      await expect(cancelledOverlay.getByRole("textbox", { name: "Arrow label" })).toBeFocused();
      await cancelledOverlay.keyboard.type("Cancel draft arrow");
      await cancelledOverlay.keyboard.press("Escape");
      await expect(cancelledOverlay.getByRole("textbox", { name: "Arrow label" })).toHaveCount(0);
      await expect(cancelledOverlay.getByRole("toolbar")).toBeVisible();
      await Promise.all([
        cancelledOverlay.waitForEvent("close"),
        cancelledOverlay.keyboard.press("Escape").catch((error: unknown) => {
          if (!cancelledOverlay.isClosed()) throw error;
        }),
      ]);
      await expect.poll(() => application.windows().length).toBe(1);
      await application.evaluate(
        () =>
          new Promise<void>((resolve) => {
            process.emitWarning("Warning after screenshot capture cancellation");
            setImmediate(resolve);
          }),
      );
      expect(
        await application.evaluate(() => ({
          failures: Reflect.get(globalThis, "captureFailures"),
          dialogs: Reflect.get(globalThis, "captureDialogs"),
        })),
      ).toEqual({ failures: [], dialogs: [] });
    }
    const opened = application.waitForEvent("window");
    await application.evaluate(() => {
      const callback = Reflect.get(globalThis, "captureShortcut");
      if (typeof callback !== "function") throw new Error("Capture shortcut was not registered");
      callback();
    });
    overlay = await opened;
    await expect(overlay.getByRole("button", { name: "Attach full display" })).toBeEnabled();
    await overlay.getByRole("button", { name: "Screenshot destination" }).click();
    await expect(overlay.locator(`[data-session-id="${originalDestination}"]`)).toHaveAttribute(
      "data-navigation-active",
      "true",
    );
    await overlay.keyboard.press("Escape");
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
    // Escape while typing cancels only the second draft arrow, not the committed first one.
    await overlay.mouse.move(start.x + 30, start.y + 30);
    await overlay.mouse.down();
    await overlay.mouse.move(end.x + 30, end.y + 30);
    await overlay.mouse.up();
    await expect(label).toBeFocused();
    await overlay.keyboard.type("Discard me");
    await expect(label).toHaveValue("Discard me");
    await overlay.keyboard.press("Escape");
    await expect(label).toHaveCount(0);
    await expect(overlay.getByRole("toolbar")).toBeVisible();
    // First Enter commits a label and first Escape discards a draft; neither closes capture.
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
    // Explicit cancellation still discards just the gesture and lets the next drag work.
    for (const cancellation of ["Escape", "pointercancel"] as const) {
      await overlay.mouse.move(cropBounds.width * 0.2, cropBounds.height * 0.4);
      await overlay.mouse.down();
      await overlay.mouse.move(cropBounds.width * 0.3, cropBounds.height * 0.6);
      if (cancellation === "Escape") await overlay.keyboard.press("Escape");
      else
        await overlay.locator("canvas").evaluate((canvas) => {
          canvas.dispatchEvent(new PointerEvent("pointercancel", { pointerId: 1, bubbles: true }));
        });
      await overlay.mouse.up();
      await expect(overlay.getByRole("toolbar")).toHaveAttribute("aria-busy", "false");
      expect(application.windows()).toHaveLength(2);
    }
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
    // Move the strip into the crop area, then out of it; its former footprint stays selectable.
    const cropGrip = overlay.getByRole("button", { name: "Move capture toolbar" });
    const cropGripBounds = (await cropGrip.boundingBox())!;
    await overlay.mouse.move(cropGripBounds.x + 15, cropGripBounds.y + 15);
    await overlay.mouse.down();
    await overlay.mouse.move(cropBounds.width * 0.15, cropBounds.height * 0.5);
    await overlay.mouse.up();
    const inAreaGrip = (await cropGrip.boundingBox())!;
    await overlay.mouse.move(inAreaGrip.x + 15, inAreaGrip.y + 15);
    await overlay.mouse.down();
    await overlay.mouse.move(cropBounds.width * 0.1, cropBounds.height * 0.35);
    await overlay.mouse.up();
    // Reverse drag includes the annotation and ends over the toolbar after capture loss.
    await overlay.mouse.move(
      cropBounds.x + cropBounds.width * 0.35,
      cropBounds.y + cropBounds.height * 0.75,
    );
    await overlay.mouse.down();
    await overlay.mouse.move(
      cropBounds.x + cropBounds.width * 0.2,
      cropBounds.y + cropBounds.height * 0.5,
    );
    // Native/browser capture loss changes event routing, not the user's intent to crop.
    // Keep moving after capture is released, then release the mouse over another element.
    await overlay.locator("canvas").evaluate(async (canvas) => {
      canvas.releasePointerCapture(1);
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      // Events for another pointer must not cancel the active mouse gesture either.
      canvas.dispatchEvent(new PointerEvent("pointercancel", { pointerId: 2, bubbles: true }));
    });
    const cropEnd = {
      x: cropBounds.x + cropBounds.width * 0.1,
      y: cropBounds.y + cropBounds.height * 0.35,
    };
    expect(
      await overlay.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.tagName, cropEnd),
    ).not.toBe("CANVAS");
    await overlay.mouse.move(cropEnd.x, cropEnd.y);
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

    // Repeat normal and interrupted drags: every release attaches once, without retries.
    for (const [index, loseCapture] of [false, true, false, true].entries()) {
      await settings.click();
      overlay = await begin();
      const canvas = overlay.locator("canvas");
      const bounds = (await canvas.boundingBox())!;
      await overlay.mouse.move(bounds.x + bounds.width * 0.2, bounds.y + bounds.height * 0.4);
      await overlay.mouse.down();
      if (loseCapture) await canvas.evaluate((element) => element.releasePointerCapture(1));
      await overlay.mouse.move(bounds.x + bounds.width * 0.4, bounds.y + bounds.height * 0.6);
      await overlay.mouse.up();
      await expect.poll(() => application.windows().length).toBe(1);
      await expect(preview).toHaveCount(3 + index);
    }

    await settings.click();
    overlay = await begin();
    await overlay.getByRole("button", { name: "Screenshot destination" }).click();
    await overlay.getByRole("button", { name: "New chat", exact: true }).click();
    await overlay.getByRole("button", { name: "New chat in Other Project", exact: true }).click();
    await expect(overlay.getByRole("button", { name: "Screenshot destination" })).toHaveText(
      "New chat · Other Project",
    );
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
    const picker = overlay.getByRole("button", { name: "Screenshot destination" });
    await picker.click();
    await expect(overlay.locator(`[data-session-id="${originalDestination}"]`)).toHaveAttribute(
      "data-navigation-active",
      "false",
    );
    await expect(
      overlay
        .getByRole("region", { name: "Other Project", exact: true })
        .locator("[data-session-id]"),
    ).toHaveCount(1);
    await overlay
      .locator(`[data-session-id="${originalDestination}"] .session-row button`)
      .first()
      .click();
    await overlay.getByRole("button", { name: "Attach full display" }).click();
    await expect.poll(() => application.windows().length).toBe(1);
    await expect(preview).toHaveCount(7);
    await expect(composer).toHaveValue("Keep this draft plus screenshot");
  } finally {
    await application.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
