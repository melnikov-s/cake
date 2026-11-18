import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { _electron as electron } from "../../scripts/queued-electron.mjs";
import { findVisualCaptureScenario } from "../../scripts/visual-capture/scenarios";

const repositoryRoot = resolve(import.meta.dirname, "../..");

async function openFixture(scenario: "relative-chat-images" | "inline-artifact") {
  const root = await mkdtemp(join(tmpdir(), "cake-viewer-escape-"));
  const paths = {
    cakeHome: join(root, "cake-home"),
    project: join(root, "project"),
    userData: join(root, "user-data"),
  };
  try {
    await findVisualCaptureScenario(scenario)!.seed(paths, "light");
    const app = await electron.launch({
      args: [repositoryRoot],
      cwd: repositoryRoot,
      env: {
        ...process.env,
        CAKE_ELECTRON_SMOKE: "1",
        CAKE_ELECTRON_USER_DATA: paths.userData,
        CAKE_HOME: paths.cakeHome,
        PI_CODING_AGENT_DIR: join(paths.cakeHome, "pi"),
        PI_CODING_AGENT_SESSION_DIR: "",
      },
    });
    return {
      app,
      async [Symbol.asyncDispose]() {
        await app.close();
        await rm(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

test("Escape closes a fullscreen image after its menu, restores focus, and allows reopening", async ({}, testInfo) => {
  await using fixture = await openFixture("relative-chat-images");
  const page = await fixture.app.firstWindow();
  await page
    .getByRole("button", { name: /^Open Project Chat for / })
    .first()
    .click();
  const opener = page.getByRole("button", { name: "View Inline capture enlarged" });
  await expect(opener).toBeVisible({ timeout: 20_000 });
  await opener.press("Enter");
  const viewer = page.getByRole("dialog", { name: "Inline capture", exact: true });
  const image = viewer.getByRole("img", { name: "Inline capture" });
  await expect(image).toBeVisible();
  await expect
    .poll(() => image.evaluate((item: HTMLImageElement) => item.naturalWidth))
    .toBeGreaterThan(0);
  await image.click({ button: "right" });
  const menu = page.getByRole("menu", { name: "Image actions" });
  await expect(menu).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).not.toBeVisible();
  await expect(viewer).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("image-open.png"), animations: "disabled" });
  await page.keyboard.press("Escape");
  await expect(viewer).not.toBeAttached();
  await expect(opener).toBeFocused();
  await expect(opener.getByRole("img")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("image-closed.png"), animations: "disabled" });

  await page.keyboard.press("Enter");
  await expect(viewer).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(viewer).not.toBeAttached();
  await expect(opener).toBeFocused();
});

test("Escape from a focused widget iframe returns to the artifact pane without resetting the preview", async ({}, testInfo) => {
  await using fixture = await openFixture("inline-artifact");
  const page = await fixture.app.firstWindow();
  await page.getByRole("button", { name: "Search sessions", exact: true }).click();
  const session = page
    .getByRole("dialog", { name: "Search sessions", exact: true })
    .locator('[data-session-id="visual-inline-artifact"]');
  await expect(session).toBeVisible();
  await session.click();
  const link = page.getByRole("link", { name: "saved visualization", exact: true });
  await expect(link).toBeVisible({ timeout: 15_000 });
  await link.press("Enter");
  const pane = page.getByRole("complementary", { name: "Inline visualization", exact: true });
  const opener = pane.getByRole("button", { name: "View Inline visualization fullscreen" });
  const inlineFrame = pane.locator("iframe");
  const inlineDetail = inlineFrame.contentFrame().getByRole("button", { name: "Explore detail" });
  await inlineDetail.click();
  await opener.press("Enter");
  const viewer = page.getByRole("dialog", { name: "Inline visualization", exact: true });
  const iframe = viewer.locator("iframe");
  const detail = iframe.contentFrame().getByRole("button", { name: /Explore detail|Hide detail/ });
  await detail.focus();
  await expect(iframe).toBeFocused();
  await page.screenshot({ path: testInfo.outputPath("artifact-open.png"), animations: "disabled" });
  await page.keyboard.press("Escape");
  await expect(viewer).not.toBeAttached();
  await expect(opener).toBeFocused();
  await expect(pane).toBeVisible();
  await expect(
    inlineFrame.contentFrame().getByRole("button", { name: "Hide detail" }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("artifact-closed.png"),
    animations: "disabled",
  });
});
