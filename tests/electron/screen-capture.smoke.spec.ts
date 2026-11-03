import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test, type Page } from "@playwright/test";
import { windowState } from "../fixtures/window-state";
import { installCaptureMicrophone, seedCaptureDictation } from "../fixtures/capture-dictation";
import {
  readClipboardImage,
  restoreClipboardSnapshot,
  saveClipboardSnapshot,
} from "./clipboard-harness";

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
  await seedCaptureDictation(userData);
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
      CAKE_SMOKE_DICTATION_HELPER: join(userData, "capture-dictation"),
    },
  });
  let clipboardSaved = false;
  try {
    // Fake only native capture/registration. Keep the real RPC, native window, editing UI,
    // compositor, destination Store, and Chat. Never capture this user's actual desktop.
    const original = await application.evaluate(
      ({
        desktopCapturer,
        nativeImage,
        screen,
        systemPreferences,
        globalShortcut,
        dialog,
        Menu,
      }) => {
        const failures: string[] = [];
        const dialogs: string[] = [];
        // Record regressions without opening a native error dialog on the user's desktop.
        process.on("uncaughtException", (error) => failures.push(error.message));
        dialog.showErrorBox = (title, content) => dialogs.push(`${title}: ${content}`);
        Object.assign(globalThis, {
          captureFailures: failures,
          captureDialogs: dialogs,
          captureSidebarMenus: [],
        });
        const buildMenu = Menu.buildFromTemplate.bind(Menu);
        Menu.buildFromTemplate = (template) => {
          const menu = buildMenu(template);
          menu.popup = (options) => {
            Reflect.get(globalThis, "captureSidebarMenus").push(
              menu.items.map(({ label }) => label),
            );
            options?.callback?.();
          };
          return menu;
        };
        const bitmap = Buffer.alloc(2400 * 1200 * 4);
        for (let index = 0; index < bitmap.length; index += 4) {
          const x = (index / 4) % 2400;
          const y = Math.floor(index / 4 / 2400);
          const shade = x < 800 ? 255 : x < 1600 ? 0 : 110;
          bitmap[index] = y < 300 ? 90 : shade;
          bitmap[index + 1] = y < 300 ? 100 : shade;
          bitmap[index + 2] = y < 300 ? 110 : shade;
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
    // Startup navigation restoration may still select its staged session after first paint.
    await expect(async () => {
      await settings.click();
      await page.getByRole("button", { name: /^Screen Capture/ }).click({ timeout: 1_000 });
      await expect(page.getByLabel("Maximum image dimension")).toBeVisible();
    }).toPass({ timeout: 10_000 });
    await installCaptureMicrophone(page);
    await page.getByRole("button", { name: /Voice & Dictation/ }).click();
    await page.getByRole("switch", { name: "Dictation mode" }).click();
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
      const bounds = (await overlay.getByRole("toolbar").boundingBox())!;
      const viewport = await overlay.evaluate(() => ({ width: innerWidth, height: innerHeight }));
      // Defaults reset on every capture, independently of the last dragged position.
      expect(bounds.y).toBe(56);
      expect(bounds.x + bounds.width / 2).toBeCloseTo(viewport.width / 2, 0);
      expect(bounds.x).toBeGreaterThanOrEqual(8);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width - 8);
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height - 8);
      return overlay;
    };
    let overlay = await begin();
    const toolbar = overlay.getByRole("toolbar", { name: "Screen capture tools" });
    const colorTrigger = overlay.getByRole("button", { name: "Annotation color", exact: true });
    await colorTrigger.click();
    const colors = overlay.getByRole("menu", { name: "Annotation color" });
    await expect(colors.getByRole("menuitemradio")).toHaveCount(6);
    await expect(colors.getByRole("menuitemradio", { name: "yellow" })).toBeFocused();
    await overlay.keyboard.press("ArrowDown");
    await overlay.keyboard.press("Enter");
    await expect(colorTrigger.locator("[data-annotation-color]")).toHaveAttribute(
      "data-annotation-color",
      "red",
    );
    await expect(colors).toHaveCount(0);
    await colorTrigger.click();
    await colors.getByRole("menuitemradio", { name: "cyan" }).click();
    await colorTrigger.click();
    await overlay.keyboard.press("Escape");
    await expect(colorTrigger).toBeFocused();
    await expect(colors).toHaveCount(0);
    await colorTrigger.click();
    await overlay.getByRole("button", { name: "Crop", exact: true }).click();
    await expect(colors).toHaveCount(0);
    const toolbarBounds = (await toolbar.boundingBox())!;
    expect(toolbarBounds.width).toBeLessThan(600);
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
    // Clamp a drag past the viewport edges.
    const currentGrip = (await grip.boundingBox())!;
    const viewport = await overlay.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    await overlay.mouse.move(currentGrip.x + 15, currentGrip.y + 15);
    await overlay.mouse.down();
    await overlay.mouse.move(viewport.width + 100, viewport.height + 100);
    await overlay.mouse.up();
    const edgeToolbar = (await toolbar.boundingBox())!;
    expect(edgeToolbar.x + edgeToolbar.width).toBeLessThanOrEqual(viewport.width - 7);
    expect(edgeToolbar.y + edgeToolbar.height).toBeLessThanOrEqual(viewport.height - 7);
    await Promise.all([
      overlay.waitForEvent("close"),
      overlay.keyboard.press("Escape").catch((error: unknown) => {
        if (!overlay.isClosed()) throw error;
      }),
    ]);
    await expect.poll(() => application.windows().length).toBe(1);
    await expect
      .poll(async () => {
        const saved = JSON.parse(await readFile(join(userData, "window-state.json"), "utf8"));
        return saved.data.children.screenCaptureStore.state.annotationColor;
      })
      .toBe("cyan");
    await page.reload();
    await expect(page.getByRole("button", { name: "Back to chat" })).toBeVisible();
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
    await expect
      .poll(() =>
        overlay.locator("canvas").evaluate((canvas) => (canvas as HTMLCanvasElement).width),
      )
      .toBe(2400);
    await expect(overlay.locator("[data-annotation-color]")).toHaveAttribute(
      "data-annotation-color",
      "cyan",
    );
    await installCaptureMicrophone(overlay);
    await overlay.getByRole("button", { name: "Annotate", exact: true }).click();
    const bounds = (await overlay.locator("canvas").boundingBox())!;
    const start = { x: bounds.x + bounds.width * 0.25, y: bounds.y + bounds.height * 0.4 };
    const end = { x: bounds.x + bounds.width * 0.6, y: bounds.y + bounds.height * 0.65 };
    await overlay.mouse.move(start.x, start.y);
    await overlay.mouse.down();
    await overlay.mouse.move(end.x, end.y);
    await overlay.mouse.up();
    const label = overlay.getByRole("textbox", { name: "Annotation comment" });
    await expect(label).toBeFocused();
    await expect(overlay.locator('[data-slot="dictation-indicator"]')).toHaveText("Listening");
    await expect(
      overlay.getByRole("button", { name: "Add annotation", exact: true }),
    ).toBeEnabled();
    const labelBounds = (await label.boundingBox())!;
    expect(labelBounds.x).toBeGreaterThanOrEqual(0);
    expect(labelBounds.x + labelBounds.width).toBeLessThanOrEqual(bounds.width);
    expect(labelBounds.y + labelBounds.height).toBeLessThanOrEqual(bounds.height);
    await overlay.keyboard.type("Look here");
    await expect(label).toHaveValue("Look here");
    await overlay.evaluate(() => {
      const processor = Reflect.get(globalThis, "captureDictationProcessor") as AudioWorkletNode;
      for (let i = 0; i < 8; i++)
        processor.port.dispatchEvent(
          new MessageEvent("message", { data: new Float32Array(1600).fill(0.1) }),
        );
    });
    await expect(label).toHaveValue("Look here Fixture dictated annotation");
    await expect(label).toBeFocused();
    await label.fill("Look here");
    await overlay.getByRole("button", { name: "Add annotation", exact: true }).click();
    await expect(label).toHaveCount(0);
    // Escape while typing cancels only the second draft arrow, not the committed first one.
    await overlay.mouse.move(start.x + 30, start.y + 30);
    await overlay.mouse.down();
    await overlay.mouse.move(end.x + 30, end.y + 30);
    await overlay.mouse.up();
    await expect(label).toBeFocused();
    await overlay.keyboard.type("Discard me");
    await expect(label).toHaveValue("Discard me");
    // Exactly like other annotations: Escape first mutes live dictation, then cancels.
    await overlay.keyboard.press("Escape");
    await expect(overlay.getByRole("button", { name: "Unmute dictation" })).toBeVisible();
    await expect(label).toHaveValue("Discard me");
    await overlay.keyboard.press("Escape");
    await expect(label).toHaveCount(0);
    await expect(overlay.getByRole("toolbar")).toBeVisible();
    // Markers reuse annotation details; edit/cancel stays separate from creation.
    await overlay.getByRole("button", { name: "Edit annotation 1", exact: true }).click();
    const details = overlay.getByRole("dialog", { name: "Annotation details" });
    await expect(details.getByText("Look here", { exact: true })).toBeVisible();
    await details.getByRole("button", { name: "Edit annotation", exact: true }).click();
    const edit = details.getByRole("textbox", { name: "Edit annotation comment" });
    await expect(edit).toBeFocused();
    await expect(edit).toHaveValue("Look here");
    await overlay.keyboard.press("ArrowRight");
    await overlay.keyboard.press("End");
    await overlay.keyboard.press("Shift+Enter");
    await overlay.keyboard.type("Second line");
    await details.getByRole("button", { name: "Save annotation", exact: true }).click();
    await overlay.getByRole("button", { name: "Edit annotation 1", exact: true }).click();
    await details.getByRole("button", { name: "Edit annotation", exact: true }).click();
    await expect(edit).toHaveValue("Look here\nSecond line");
    await edit.fill("Discard this edit");
    await overlay.keyboard.press("Escape");
    await expect(details.getByText("Look here\nSecond line", { exact: true })).toBeVisible();
    await overlay.keyboard.press("Escape");
    await expect(details).toHaveCount(0);
    await expect(overlay.getByRole("toolbar")).toBeVisible();

    // Trusted touch input uses the same release-to-composer path for freehand.
    await overlay.getByRole("button", { name: "Freehand", exact: true }).click();
    const touch = await overlay.context().newCDPSession(overlay);
    const touchPoints = (x: number, y: number) => [{ x, y, id: 1 }];
    await touch.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: touchPoints(bounds.width * 0.2, bounds.height * 0.7),
    });
    await touch.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: touchPoints(bounds.width * 0.4, bounds.height * 0.8),
    });
    await touch.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: touchPoints(bounds.width * 0.2, bounds.height * 0.7),
    });
    await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await touch.detach();
    await expect(label).toBeFocused();
    await overlay.keyboard.type("Freehand note");
    await overlay.keyboard.press("Enter");
    await expect(
      overlay.getByRole("button", { name: "Edit annotation 2", exact: true }),
    ).toHaveCount(1);
    // Repaint identical annotations under hostile light/dark/custom chrome tokens.
    const painted = await overlay
      .locator("canvas")
      .evaluate((canvas: HTMLCanvasElement) => canvas.toDataURL());
    for (const theme of ["light", "dark"]) {
      await overlay.evaluate((theme) => {
        document.documentElement.dataset.theme = theme;
        document.documentElement.style.setProperty("--accent", "#665544");
        document.documentElement.style.setProperty(
          "--background",
          theme === "light" ? "#ffffff" : "#000000",
        );
        document.documentElement.style.setProperty("--foreground", "#665544");
      }, theme);
      // Changing color then restoring it forces a real canvas repaint.
      await overlay.getByRole("button", { name: "Annotation color", exact: true }).click();
      await overlay.getByRole("menuitemradio", { name: "red" }).click();
      await overlay.getByRole("button", { name: "Annotation color", exact: true }).click();
      await overlay.getByRole("menuitemradio", { name: "cyan" }).click();
      expect(
        await overlay.locator("canvas").evaluate((canvas: HTMLCanvasElement) => canvas.toDataURL()),
      ).toBe(painted);
    }
    await saveClipboardSnapshot(application, "previousCaptureClipboard");
    clipboardSaved = true;
    await overlay.getByRole("button", { name: "Copy image and text", exact: true }).click();
    await expect(overlay.getByRole("alert")).toHaveCount(0);
    await expect(overlay.getByRole("button", { name: "Copy image and text" })).toBeEnabled();
    await expect
      .poll(() => application.evaluate(({ clipboard }) => clipboard.readText()))
      .toBe("1. Look here\n   Second line\n2. Freehand note");
    const copied = await readClipboardImage(application);
    expect(copied.size).toEqual({
      width: 1024,
      height: 512,
    });
    await restoreClipboardSnapshot(application, "previousCaptureClipboard");
    clipboardSaved = false;
    // Destination choice is already available in the native editor. Escape dismisses only the menu.
    const destinationMenu = overlay.getByRole("dialog", { name: "Screenshot destination" });
    const destinationTrigger = overlay.getByRole("button", {
      name: "Screenshot destination",
      exact: true,
    });
    await destinationTrigger.click();
    await expect(destinationMenu).toBeVisible();
    await overlay.keyboard.press("Escape");
    await expect(destinationMenu).toHaveCount(0);
    await expect(destinationTrigger).toBeFocused();
    await page.getByRole("button", { name: "Back to chat", exact: true }).click();
    const mainSidebar = page.locator('[data-slot="sidebar"][data-view="navigation"]');
    await mainSidebar.getByRole("button", { name: "Collapse project", exact: true }).click();
    await destinationTrigger.click();
    await expect(
      destinationMenu.getByRole("button", { name: "Collapse project", exact: true }),
    ).toHaveAttribute("aria-expanded", "true");
    await destinationMenu.getByRole("button", { name: "Collapse project", exact: true }).click();
    await mainSidebar.getByRole("button", { name: "Expand project", exact: true }).click();
    await expect(
      destinationMenu.getByRole("button", { name: "Expand project", exact: true }),
    ).toHaveAttribute("aria-expanded", "false");
    await overlay.keyboard.press("Escape");
    await destinationTrigger.click();
    await expect(
      destinationMenu.getByRole("button", { name: "Expand project", exact: true }),
    ).toBeVisible();
    await overlay.keyboard.press("Escape");
    await overlay.getByRole("button", { name: "Crop", exact: true }).click();
    await expect(overlay.getByRole("button", { name: "Undo drawing" })).toBeEnabled();
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
      let cyan = 0;
      let black = 0;
      let white = 0;
      for (let index = 0; index < bitmap.length; index += 4) {
        if (bitmap[index] === 255 && bitmap[index + 1] === 217 && bitmap[index + 2] === 0) cyan++;
        if (bitmap[index] === 0 && bitmap[index + 1] === 0 && bitmap[index + 2] === 0) black++;
        if (bitmap[index] === 255 && bitmap[index + 1] === 255 && bitmap[index + 2] === 255)
          white++;
        if (
          bitmap[index] !== bitmap[0] ||
          bitmap[index + 1] !== bitmap[1] ||
          bitmap[index + 2] !== bitmap[2]
        ) {
          annotated += 1;
          if (index < width * Math.floor(height / 4) * 4) chrome += 1;
        }
      }
      return { annotated, chrome, cyan, black, white };
    }, source!);
    expect(pixels.annotated).toBeGreaterThan(100);
    expect(pixels.chrome).toBe(0);
    expect(pixels.cyan).toBeGreaterThan(100);
    expect(pixels.black).toBeGreaterThan(100);
    expect(pixels.white).toBeGreaterThan(100);
    await expect(composer).toHaveValue(
      /Keep this draft\n\nScreenshot-[^\n]+\n1\. Look here\n {3}Second line\n2\. Freehand note/,
    );
    await composer.click();
    await expect(composer).toBeFocused();
    await composer.evaluate((input: HTMLTextAreaElement) =>
      input.setSelectionRange(input.value.length, input.value.length),
    );
    await page.keyboard.type(" plus screenshot");
    await expect(composer).toHaveValue(/2\. Freehand note plus screenshot$/);
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();

    await settings.click();
    await page.getByRole("button", { name: /Voice & Dictation/ }).click();
    await page.getByRole("switch", { name: "Dictation mode" }).click();
    await page.getByRole("button", { name: /^Screen Capture/ }).click();
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
    await expect(overlay.getByRole("textbox", { name: "Annotation comment" })).toBeFocused();
    await overlay.keyboard.type("Crop this annotation");
    await expect(overlay.getByRole("textbox", { name: "Annotation comment" })).toHaveValue(
      "Crop this annotation",
    );
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
    // A project label selects its permanent Project Chat before attaching.
    await overlay.getByRole("button", { name: "Screenshot destination", exact: true }).click();
    await overlay
      .getByRole("dialog", { name: "Screenshot destination" })
      .getByRole("button", { name: "Open Project Chat for Other Project" })
      .click();
    await overlay.getByRole("button", { name: "Attach full display" }).click();
    await expect.poll(() => application.windows().length).toBe(1);
    await expect(preview).toHaveCount(1);
    const projectComposer = page.getByRole("combobox", {
      name: "Message Project Chat",
      exact: true,
    });
    await expect(projectComposer).toHaveValue("");
    await projectComposer.click();
    await expect(projectComposer).toBeFocused();
    await page.keyboard.type("Project Chat screenshot");
    await expect(projectComposer).toHaveValue("Project Chat screenshot");
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Go back in session history" }).click();
    await expect(preview).toHaveCount(6);
    // Back changes navigation, not interaction. Explicitly interact with this draft before capturing again.
    await composer.click();
    await settings.click();
    overlay = await begin();
    await overlay.getByRole("button", { name: "Attach full display" }).click();
    await expect.poll(() => application.windows().length).toBe(1);
    await expect(preview).toHaveCount(7);
    await expect(composer).toHaveValue(
      /1\. Look here\n {3}Second line\n2\. Freehand note plus screenshot/,
    );

    // A small secondary display still gets the entire toolbar, in logical rather than Retina pixels.
    await application.evaluate(({ screen }) => {
      const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
      screen.getDisplayNearestPoint = () => ({
        ...display,
        bounds: { x: -640, y: 0, width: 640, height: 480 },
        size: { width: 640, height: 480 },
        scaleFactor: 2,
      });
    });
    await settings.click();
    overlay = await begin();
    expect(await overlay.evaluate(() => ({ width: innerWidth, height: innerHeight }))).toEqual({
      width: 640,
      height: 480,
    });
    await Promise.all([
      overlay.waitForEvent("close"),
      overlay.getByRole("button", { name: "Cancel", exact: true }).click(),
    ]);
    // Feed the formats captured at Copy time through Cake's native DOM paste handler;
    // the system clipboard need not stay unchanged through the intervening workflow.
    await page.getByRole("button", { name: "Back to chat", exact: true }).click();
    const imageCount = await preview.count();
    await composer.fill("Clipboard review:\n");
    await composer.evaluate((input, payload) => {
      const transfer = new DataTransfer();
      transfer.setData("text/plain", payload.text);
      transfer.items.add(
        new File(
          [Uint8Array.from(atob(payload.data), (char) => char.charCodeAt(0))],
          "Copied screenshot.png",
          { type: "image/png" },
        ),
      );
      input.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }),
      );
    }, copied);
    await expect(composer).toHaveValue(
      "Clipboard review:\n1. Look here\n   Second line\n2. Freehand note",
    );
    await expect(preview).toHaveCount(imageCount); // The pasted file has its own name.
    await expect(
      page.getByRole("button", { name: "View Copied screenshot.png enlarged", exact: true }),
    ).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
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
      await expect(
        cancelledOverlay.getByRole("textbox", { name: "Annotation comment" }),
      ).toBeFocused();
      await cancelledOverlay.keyboard.type("Cancel draft arrow");
      await cancelledOverlay.keyboard.press("Escape");
      await expect(
        cancelledOverlay.getByRole("textbox", { name: "Annotation comment" }),
      ).toHaveCount(0);
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
  } finally {
    if (clipboardSaved) await restoreClipboardSnapshot(application, "previousCaptureClipboard");
    await application.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
