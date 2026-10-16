import { mkdtemp, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { findVisualCaptureScenario } from "../../scripts/visual-capture/scenarios";
import { CAKE_CHAT_SESSION_ID } from "../../src/contracts/cake-chats/cake-chat-identity";

const repositoryRoot = resolve(import.meta.dirname, "../..");

test("Cake Chat opens only its linked artifacts alongside the conversation and browses the library explicitly", async () => {
  const root = await mkdtemp(join(tmpdir(), "cake-artifact-pane-"));
  const paths = {
    cakeHome: join(root, "cake-home"),
    project: join(root, "project"),
    userData: join(root, "user-data"),
  };
  const scenario = findVisualCaptureScenario("cake-chat-artifact")!;
  await scenario.seed(paths, "dark");
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
    const pane = page.getByRole("complementary", { name: "Artifact", exact: true });
    const layout = page.locator('[data-slot="artifact-pane-layout"]');
    await expect(layout).toHaveAttribute("data-presentation", "side-by-side");
    await expect(page.getByLabel("Search artifact library")).not.toBeAttached();
    await page.evaluate(() =>
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: async () => undefined },
      }),
    );
    await pane.getByRole("button", { name: "Copy readable path", exact: true }).click();
    await expect(pane.getByText("Copied", { exact: true })).toBeVisible();
    const input = page.getByLabel("Message Cake Chat", { exact: true });
    await input.click();
    await expect(input).toBeFocused();
    await input.pressSequentially("Use this report");
    await expect(input).toHaveValue("Use this report");
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
    const handle = page.getByRole("separator", { name: "Resize artifact pane" });
    await handle.focus();
    await handle.press("ArrowLeft");
    await expect(pane).toBeVisible();
    await page.getByRole("button", { name: "1 artifacts" }).click();
    const menu = page.getByRole("dialog", { name: "Artifacts", exact: true });
    await page.keyboard.press("Escape");
    await expect(menu).not.toBeAttached();
    await expect(pane).toBeVisible();
    await pane.getByRole("button", { name: "Close Artifact", exact: true }).click();
    await expect(pane).not.toBeAttached();
    await expect(input).toHaveValue("Use this report");
    await page.getByRole("button", { name: "1 artifacts" }).click();
    await menu.getByRole("button", { name: /Coordinator report/ }).click();
    await expect(pane).toBeVisible();
    await page.setViewportSize({ width: 700, height: 900 });
    await expect(layout).toHaveAttribute("data-presentation", "replacement");
    await pane.getByRole("button", { name: "Close Artifact", exact: true }).click();
    await expect(input).toBeVisible();
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
    await input.click();
    await input.pressSequentially(" again");
    await expect(input).toHaveValue("Use this report again");
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
  } finally {
    await app.close();
    await promisify(execFile)("chmod", ["-R", "u+w", root]);
    await rm(root, { recursive: true, force: true });
  }
});
