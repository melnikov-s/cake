import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "../../scripts/queued-electron.mjs";
import { expect, test } from "@playwright/test";
import { windowState } from "../fixtures/window-state";

const repositoryRoot = resolve(import.meta.dirname, "../..");

test("holds Enter to adjust automatic capture bounds and exports only the final annotated crop", async () => {
  test.setTimeout(60_000);
  const macOS = process.platform === "darwin";
  const temporaryRoot = await mkdtemp(join(tmpdir(), "cake-capture-hold-"));
  const project = join(temporaryRoot, "project");
  const cakeHome = join(temporaryRoot, "cake-home");
  const userData = join(temporaryRoot, "user-data");
  await Promise.all([
    mkdir(project, { recursive: true }),
    mkdir(join(cakeHome, "state"), { recursive: true }),
    mkdir(userData, { recursive: true }),
  ]);
  await writeFile(join(userData, "window-state.json"), windowState({ project, theme: "dark" }));
  await writeFile(
    join(cakeHome, "state", "application.json"),
    JSON.stringify({
      schemaVersion: 1,
      projects: [
        {
          path: project,
          name: "Capture hold",
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
      PI_CODING_AGENT_DIR: join(cakeHome, "pi"),
      PI_CODING_AGENT_SESSION_DIR: "",
    },
  });
  try {
    await application.evaluate(
      ({ desktopCapturer, nativeImage, screen, systemPreferences, globalShortcut }) => {
        // Synthetic desktop only. The negative origin and scaled bitmap exercise both coordinate spaces.
        const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
        screen.getDisplayNearestPoint = () => ({
          ...display,
          bounds: { x: -640, y: -480, width: 640, height: 480 },
          workArea: { x: -640, y: -448, width: 640, height: 420 },
          size: { width: 640, height: 480 },
          scaleFactor: 2,
        });
        const bitmap = Buffer.alloc(2400 * 1200 * 4, 255);
        // Menu bar: red, next 40px of app title bar: cyan, rest of desktop: white.
        for (let y = 0; y < 120; y++) {
          for (let x = 0; x < 2400; x++) {
            const offset = (y * 2400 + x) * 4;
            bitmap[offset] = y < 80 ? 0 : 255;
            bitmap[offset + 1] = y < 80 ? 0 : 255;
            bitmap[offset + 2] = y < 80 ? 255 : 0;
          }
        }
        const image = nativeImage.createFromBitmap(bitmap, {
          width: 2400,
          height: 1200,
        });
        desktopCapturer.getSources = async () => [
          {
            id: "screen:fixture",
            name: "Fixture display",
            display_id: String(display.id),
            thumbnail: image,
            appIcon: null,
          },
        ];
        systemPreferences.getMediaAccessStatus = () => "granted";
        globalShortcut.register = () => true;
        globalShortcut.unregister = () => {};
      },
    );
    const page = await application.firstWindow();
    const composer = page.getByRole("combobox", { name: "Message Cake Chat", exact: true });
    await expect(composer).toBeVisible({ timeout: 20_000 });
    await composer.click();
    await page.keyboard.type("Retain this draft");
    const settings = page
      .getByRole("navigation", { name: "Projects and global utilities" })
      .getByRole("button", { name: "Settings", exact: true });
    await expect(async () => {
      await settings.click();
      await page.getByRole("button", { name: /^Screen Capture/ }).click({ timeout: 1000 });
      await expect(page.getByLabel("Maximum image dimension")).toBeVisible();
    }).toPass({ timeout: 10_000 });
    await page.getByLabel("Maximum image dimension").selectOption("1024");
    let opened = application.waitForEvent("window");
    await page.getByRole("button", { name: "Capture screenshot", exact: true }).click();
    let overlay = await opened;
    await expect(overlay.getByRole("toolbar", { name: "Screen capture tools" })).toBeVisible();
    await expect
      .poll(() => overlay.locator("canvas").evaluate((canvas: HTMLCanvasElement) => canvas.width))
      .toBe(2400);
    expect(
      await application.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().every((window) => !window.isVisible() && !window.isFocused()),
      ),
    ).toBe(true);
    const preview = page.getByRole("button", { name: /^View [a-z0-9]{3}\.png enlarged$/ });
    // Hold/release uses screenshot pixels even on a smaller, offset display.
    let selection = overlay.getByRole("group", { name: "Capture bounds" });
    await overlay.keyboard.down("Enter");
    await expect(selection).toHaveCSS("top", macOS ? "32px" : "0px");
    await expect(selection).toHaveCSS("height", macOS ? "448px" : "480px");
    const evidenceDirectory = join(repositoryRoot, ".visual-captures", "menu-bar-exclusion");
    await mkdir(evidenceDirectory, { recursive: true });
    await overlay.screenshot({ path: join(evidenceDirectory, "automatic-preview.png") });
    await overlay.keyboard.up("Enter");
    await expect.poll(() => application.windows().length).toBe(1);
    await expect(preview).toHaveCount(1);
    const previousImages = await preview.count();
    const safeImage = (await preview.locator("img").getAttribute("src"))!;
    const safeExport = await application.evaluate(({ nativeImage }, data) => {
      const image = nativeImage.createFromDataURL(data);
      return { size: image.getSize(), corner: [...image.toBitmap().subarray(0, 4)] };
    }, safeImage);
    expect(safeExport.size).toEqual({ width: 1024, height: macOS ? 478 : 512 });
    // On macOS the red menu is gone, but the adjacent cyan app title bar remains.
    expect(safeExport.corner).toEqual(macOS ? [255, 255, 0, 255] : [0, 0, 255, 255]);
    await writeFile(
      join(evidenceDirectory, "automatic-export.png"),
      Buffer.from(safeImage.split(",")[1]!, "base64"),
    );
    await test.info().attach("menu-bar-free-export", {
      path: join(evidenceDirectory, "automatic-export.png"),
      contentType: "image/png",
    });
    // Successful attachment returns to chat and closes Settings; reopen before the next capture.
    await settings.click();
    await page.getByRole("button", { name: /^Screen Capture/ }).click();
    opened = application.waitForEvent("window");
    await page.getByRole("button", { name: "Capture screenshot", exact: true }).click();
    overlay = await opened;
    await expect(overlay.getByRole("toolbar", { name: "Screen capture tools" })).toBeVisible();
    selection = overlay.getByRole("group", { name: "Capture bounds" });
    await overlay.keyboard.down("Enter");
    await expect(selection).toHaveCSS("width", "640px");
    await expect(selection).toHaveCSS("top", macOS ? "32px" : "0px");
    await expect(selection).toHaveCSS("height", macOS ? "448px" : "480px");
    await overlay.keyboard.down("Enter"); // Native keyboard repeat must not capture.
    await expect(selection).toBeVisible();
    await overlay.keyboard.press("Escape");
    await overlay.keyboard.up("Enter");
    await expect(selection).toHaveCount(0);
    await expect(overlay.getByRole("toolbar")).toBeVisible();
    // A canceled hold cannot be revived by repeat or its eventual keyup.
    await overlay.keyboard.down("Enter");
    await overlay.evaluate(() => window.dispatchEvent(new Event("blur")));
    await overlay.keyboard.up("Enter");
    await expect(selection).toHaveCount(0);
    await overlay.getByRole("button", { name: "Freehand", exact: true }).click();
    await overlay.mouse.move(160, 192);
    await overlay.mouse.down();
    await overlay.mouse.move(320, 288);
    await overlay.mouse.up();
    const autoLabel = overlay.getByRole("textbox", { name: "Annotation comment" });
    await expect(autoLabel).toBeFocused();
    await overlay.keyboard.type("Auto crop");
    await overlay.keyboard.press("Enter"); // Saves text; its release must not capture.
    await expect(autoLabel).toHaveCount(0);
    await expect(selection).toHaveCount(0);
    await expect(overlay.getByRole("toolbar")).toBeVisible();
    // Explicitly cover contenteditable keyboard focus as well as the real textarea above.
    await overlay.evaluate(() => {
      const editor = document.createElement("div");
      editor.contentEditable = "true";
      editor.setAttribute("aria-label", "Editable capture test");
      document.body.append(editor);
      editor.focus();
    });
    await overlay.keyboard.press("Enter");
    await expect(selection).toHaveCount(0);
    await overlay.evaluate(() =>
      document.querySelector('[aria-label="Editable capture test"]')?.remove(),
    );
    await overlay.keyboard.down("Enter");
    // Union [600,480]..[1200,720], padded 300 screenshot pixels on each side.
    await expect(selection).toHaveCSS("left", "80px");
    await expect(selection).toHaveCSS("top", "72px");
    await expect(selection).toHaveCSS("width", "320px");
    await expect(selection).toHaveCSS("height", "336px");
    const dragBounds = async (name: string, dx: number, dy: number) => {
      const box = (await overlay.getByRole("button", { name, exact: true }).boundingBox())!;
      await overlay.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await overlay.mouse.down();
      await overlay.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy);
      await overlay.mouse.up();
      await expect(selection).toBeVisible(); // Mouse release edits; only Enter release captures.
    };
    await dragBounds("Move capture bounds", 20, 20);
    await expect(selection).toHaveCSS("left", "100px");
    await expect(selection).toHaveCSS("top", "92px");
    await dragBounds("Resize capture bounds e", 40, 0);
    await expect(selection).toHaveCSS("width", "360px");
    await dragBounds("Resize capture bounds nw", -20, -20);
    await expect(selection).toHaveCSS("left", "80px");
    await expect(selection).toHaveCSS("top", "72px");
    await expect(selection).toHaveCSS("width", "380px");
    await expect(selection).toHaveCSS("height", "356px");
    await overlay.keyboard.down("Enter");
    await expect(selection).toHaveCSS("width", "380px"); // Repeat must not reset bounds either.
    await overlay.keyboard.up("Enter");
    await expect.poll(() => application.windows().length).toBe(1);
    await expect(preview).toHaveCount(previousImages + 1);
    const automaticImage = await preview.last().locator("img").getAttribute("src");
    const exported = await application.evaluate(({ nativeImage }, data) => {
      const image = nativeImage.createFromDataURL(data);
      return { size: image.getSize(), corner: [...image.toBitmap().subarray(0, 4)] };
    }, automaticImage!);
    // Final rect is 1425x890 source pixels; maxDimension=1024 downsamples that exact crop.
    expect(exported.size).toEqual({ width: 1024, height: 640 });
    // Top-left source is plain white: neither selection paint nor handles are exported.
    expect(exported.corner).toEqual([255, 255, 255, 255]);
    await expect(composer).toHaveValue(/1\. Auto crop/);
  } finally {
    await application.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
