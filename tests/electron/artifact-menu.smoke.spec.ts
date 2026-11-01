import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { findVisualCaptureScenario, seedArtifact } from "../../scripts/visual-capture/scenarios";
import type { CakeArtifactV1 } from "../../src/contracts/artifacts/artifact-contract";
import { CAKE_CHAT_SESSION_ID } from "../../src/contracts/cake-chats/cake-chat-identity";

const repositoryRoot = resolve(import.meta.dirname, "../..");

for (const theme of ["light", "dark"] as const) {
  test(`Cake Chat artifact opens in the shared pane, expands and returns without losing scroll or chat (${theme})`, async () => {
    const root = await mkdtemp(join(tmpdir(), "cake-artifact-menu-"));
    const paths = {
      cakeHome: join(root, "cake-home"),
      project: join(root, "project"),
      userData: join(root, "user-data"),
    };
    const scenario = findVisualCaptureScenario("cake-chat-artifact")!;
    await scenario.seed(paths, theme);
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
    try {
      const page = await app.firstWindow();
      await page.setViewportSize({ width: 1600, height: 1000 });
      await scenario.prepare(page, "default");
      const pane = page.getByRole("complementary", { name: "Coordinator report", exact: true });
      const layout = page.locator('[data-slot="side-chat-layout"]').first();
      await expect(layout).toHaveAttribute("data-presentation", "side-by-side");
      await expect(page.getByRole("separator", { name: "Resize side chat" })).toBeVisible();
      const paneWidth = (await pane.boundingBox())!.width;
      const content = pane.locator('[data-artifact-id="coordinator-report"]');
      const scroll = await content.evaluate((element) => {
        if (element.scrollHeight <= element.clientHeight) throw new Error("Report must overflow");
        element.scrollTop = 220;
        return element.scrollTop;
      });
      expect(scroll).toBeGreaterThan(0);
      await pane.getByRole("button", { name: "View Coordinator report fullscreen" }).click();
      const surface = page.getByRole("dialog", { name: "Coordinator report", exact: true });
      expect(await surface.boundingBox()).toEqual({ x: 0, y: 0, width: 1600, height: 1000 });
      expect(
        await surface
          .locator('[data-artifact-id="coordinator-report"]')
          .evaluate((e) => e.scrollTop),
      ).toBe(scroll);
      await expect(page.getByRole("dialog", { name: "Artifacts", exact: true })).not.toBeAttached();
      await expect(page.getByLabel("Search artifact library")).not.toBeAttached();
      await surface.getByRole("button", { name: "Open chat", exact: true }).click();
      const presentationInput = surface.getByLabel("Message Cake Chat", { exact: true });
      await presentationInput.click();
      await expect(presentationInput).toBeFocused();
      await presentationInput.pressSequentially("Use this report");
      await expect(presentationInput).toHaveValue("Use this report");
      await expect(surface.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
      await surface.getByRole("button", { name: "Close chat", exact: true }).click();
      await page.keyboard.press("Escape");
      await expect(surface).not.toBeAttached();
      await expect(pane).toBeVisible();
      expect(await content.evaluate((e) => e.scrollTop)).toBe(scroll);
      const input = page.getByLabel("Message Cake Chat", { exact: true });
      await expect(input).toHaveValue("Use this report");

      // The to-do toggle replaces the artifact in the same accessory slot/width.
      await page.getByRole("button", { name: "To-do", exact: true }).click();
      await expect(page.getByRole("searchbox", { name: "Search to-dos" })).toBeVisible();
      await expect(pane).not.toBeAttached();
      await page.getByRole("button", { name: "1 artifacts" }).click();
      const menu = page.getByRole("dialog", { name: "Artifacts", exact: true });
      await menu.getByRole("button", { name: /Coordinator report/ }).click();
      await expect(pane).toBeVisible();
      expect((await pane.boundingBox())!.width).toBe(paneWidth);
      await expect(page.getByRole("searchbox", { name: "Search to-dos" })).not.toBeAttached();
      await page.setViewportSize({ width: 700, height: 900 });
      await expect(layout).toHaveAttribute("data-presentation", "replacement");
      await pane.getByRole("button", { name: "View Coordinator report fullscreen" }).click();
      expect(await surface.boundingBox()).toEqual({ x: 0, y: 0, width: 700, height: 900 });
      await surface.getByRole("button", { name: "Exit fullscreen Coordinator report" }).click();
      await expect(pane).toBeVisible();
      await pane.getByRole("button", { name: "Close Coordinator report" }).click();
      await page.getByRole("button", { name: "1 artifacts" }).click();
      await menu.getByRole("button", { name: "Browse all artifacts" }).click();
      await expect(page.getByLabel("Search artifact library")).toBeVisible();
      await expect(page.getByRole("button", { name: /Unrelated project report/ })).toBeVisible();
      await page.getByRole("button", { name: "Close all artifacts", exact: true }).click();
      await expect(page.locator('[data-slot="workspace"]')).toHaveAttribute(
        "data-session-id",
        CAKE_CHAT_SESSION_ID,
      );
      await expect(input).toHaveValue("Use this report");

      // A global selection retains the existing standalone fullscreen behavior over Settings.
      await page.setViewportSize({ width: 1600, height: 1000 });
      await page.getByRole("button", { name: "Open settings", exact: true }).click();
      await page.getByRole("button", { name: "Artifacts", exact: true }).click();
      await menu.getByRole("button", { name: /Coordinator report/ }).click();
      await expect(surface.getByRole("heading", { name: "Session artifact" })).toBeVisible();
      await expect(page.getByLabel("Search artifact library")).not.toBeAttached();
      await surface.getByRole("button", { name: "Exit fullscreen Coordinator report" }).click();
      await expect(page.getByRole("button", { name: "Back to chat", exact: true })).toBeVisible();
    } finally {
      await app.close();
      await promisify(execFile)("chmod", ["-R", "u+w", root]);
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("Widget keeps its live frame and unsaved edits from side pane to fullscreen and back", async () => {
  const root = await mkdtemp(join(tmpdir(), "cake-widget-menu-"));
  const paths = {
    cakeHome: join(root, "cake-home"),
    project: join(root, "project"),
    userData: join(root, "user-data"),
  };
  await findVisualCaptureScenario("inline-artifact")!.seed(paths, "dark");
  // Reuse the compiled widget with the permanent-chat fixture. The Project
  // Session fixture currently stalls before mounting even on the base revision.
  const blobs = join(paths.cakeHome, "state", "artifacts", "blobs");
  const widget: CakeArtifactV1 = JSON.parse(
    await readFile(join(blobs, (await readdir(blobs))[0]!), "utf8"),
  );
  await findVisualCaptureScenario("cake-chat")!.seed(paths, "dark");
  await seedArtifact(
    paths,
    { ...widget, id: "cake-widget", sessionId: CAKE_CHAT_SESSION_ID },
    new Date(0).toISOString(),
  );
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
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1600, height: 1000 });
    await findVisualCaptureScenario("cake-chat")!.prepare(page, "default");
    await page.getByRole("button", { name: "1 artifacts" }).click();
    await page
      .getByRole("dialog", { name: "Artifacts", exact: true })
      .getByRole("button", { name: /Inline visualization/ })
      .click();
    const pane = page.getByRole("complementary", { name: "Inline visualization", exact: true });
    const surface = page.getByRole("dialog", { name: "Inline visualization", exact: true });
    const artifact = page.locator('[data-artifact-id="cake-widget"]');
    await expect(artifact.locator("[data-widget-view-ready]")).toHaveAttribute(
      "data-widget-view-ready",
      "true",
    );
    const frame = artifact.locator("iframe");
    const detail = frame.contentFrame().getByRole("button", { name: "Explore detail" });
    await expect(detail).toBeVisible();
    await detail.click();
    await expect(frame.contentFrame().getByRole("button", { name: "Hide detail" })).toBeVisible();
    const src = await frame.getAttribute("src");
    await frame
      .contentFrame()
      .locator("main")
      .evaluate((element) => {
        element.dataset.menuUnsaved = "retained";
      });
    await pane.getByRole("button", { name: "View Inline visualization fullscreen" }).click();
    await expect(surface.locator("iframe")).toHaveAttribute("src", src!);
    await expect(frame.contentFrame().locator("main")).toHaveAttribute(
      "data-menu-unsaved",
      "retained",
    );
    await surface.getByRole("button", { name: "Open chat", exact: true }).click();
    const input = surface.getByRole("combobox", { name: "Message Cake Chat", exact: true });
    await input.click();
    await expect(input).toBeFocused();
    await input.pressSequentially("Change this widget");
    await expect(input).toHaveValue("Change this widget");
    await expect(surface.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
    await surface.getByRole("button", { name: "Close chat", exact: true }).click();
    await expect(frame).toHaveAttribute("src", src!);
    await expect(frame.contentFrame().locator("main")).toHaveAttribute(
      "data-menu-unsaved",
      "retained",
    );
    await surface.getByRole("button", { name: "Exit fullscreen Inline visualization" }).click();
    await expect(surface).not.toBeAttached();
    await expect(pane.locator("iframe")).toHaveAttribute("src", src!);
    await expect(frame.contentFrame().locator("main")).toHaveAttribute(
      "data-menu-unsaved",
      "retained",
    );
    await expect(frame.contentFrame().getByRole("button", { name: "Hide detail" })).toBeVisible();
    await expect(
      page.getByRole("combobox", { name: "Message Cake Chat", exact: true }),
    ).toHaveValue("Change this widget");
  } finally {
    await app.close();
    await promisify(execFile)("chmod", ["-R", "u+w", root]);
    await rm(root, { recursive: true, force: true });
  }
});
