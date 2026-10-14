import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { windowState } from "../fixtures/window-state";

const repositoryRoot = resolve(import.meta.dirname, "../..");

test("opens attached images fullscreen from the uniform composer tile and from the transcript", async () => {
  test.setTimeout(60_000);
  const temporaryRoot = await mkdtemp(join(tmpdir(), "cake-chat-image-preview-"));
  const userData = join(temporaryRoot, "user-data");
  const project = join(temporaryRoot, "project");
  const cakeHome = join(temporaryRoot, "cake-home");
  await Promise.all([
    mkdir(userData, { recursive: true }),
    mkdir(project, { recursive: true }),
    mkdir(join(cakeHome, "state"), { recursive: true }),
  ]);
  await writeFile(join(userData, "window-state.json"), windowState({ project, theme: "system" }));
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
      ],
      trustedProjectPaths: [project],
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
    const page = await application.firstWindow();
    const composer = page.getByRole("combobox", { name: "Message", exact: true });
    await expect(composer).toBeVisible({ timeout: 20_000 });
    const imageData = await application.evaluate(({ nativeImage }) =>
      nativeImage
        .createFromBitmap(Buffer.alloc(320 * 20 * 4, 255), { width: 320, height: 20 })
        .toPNG()
        .toString("base64"),
    );
    const pasteImage = () =>
      composer.evaluate((element, data) => {
        const clipboard = new DataTransfer();
        clipboard.items.add(
          new File(
            [Uint8Array.from(atob(data), (character) => character.charCodeAt(0))],
            "wide.png",
            { type: "image/png" },
          ),
        );
        element.dispatchEvent(
          new ClipboardEvent("paste", {
            bubbles: true,
            cancelable: true,
            clipboardData: clipboard,
          }),
        );
      }, imageData);
    await pasteImage();
    const preview = page.getByRole("button", { name: "View wide.png enlarged" });
    await expect(preview).toBeVisible();
    const tile = preview.locator("..");
    const bounds = (await tile.boundingBox())!;
    expect(bounds).toMatchObject({ width: 192, height: 80 });
    const thumbnail = preview.getByRole("img", { name: "wide.png", exact: true });
    await expect(thumbnail).toBeVisible();
    await expect(thumbnail).toHaveAttribute("src", `data:image/png;base64,${imageData}`);
    await expect
      .poll(() => thumbnail.evaluate((image: HTMLImageElement) => image.naturalWidth))
      .toBe(320);
    // The whole tile is the preview action, not just the thumbnail.
    await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height - 8);
    const fullscreen = page.getByRole("dialog", { name: "wide.png", exact: true });
    await expect(fullscreen).toBeVisible({ timeout: 3_000 });
    expect(await fullscreen.boundingBox()).toEqual(
      await page.evaluate(() => ({ x: 0, y: 0, width: innerWidth, height: innerHeight })),
    );
    await expect(fullscreen.locator("img")).toHaveAttribute(
      "src",
      `data:image/png;base64,${imageData}`,
    );
    await page.keyboard.press("Escape");
    await expect(fullscreen).toHaveCount(0);
    await expect(preview).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(fullscreen).toBeVisible();
    await fullscreen.getByRole("button", { name: "Exit fullscreen wide.png" }).click();
    await expect(preview).toBeFocused();

    // Removing an image must not accidentally open its preview.
    await page.getByRole("button", { name: "Remove wide.png" }).click();
    await expect(preview).toHaveCount(0);
    await expect(fullscreen).toHaveCount(0);

    // Paste again and save as a draft to exercise the transcript without a model call.
    await pasteImage();
    await composer.click();
    await page.keyboard.type("Inspect this image");
    await expect(composer).toHaveValue("Inspect this image");
    await page.getByRole("button", { name: "Draft", exact: true }).click();
    await expect(page.getByRole("button", { name: "Create draft" })).toBeEnabled();
    await page.getByRole("button", { name: "Create draft" }).click();
    await expect(composer).toHaveCount(0);
    await preview.click();
    await expect(fullscreen).toBeVisible();
    await fullscreen.getByRole("button", { name: "Exit fullscreen wide.png" }).click();
    await expect(fullscreen).toHaveCount(0);
  } finally {
    await application.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
