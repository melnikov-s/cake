import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";
import { seedMessageBoardFixture, MESSAGE_BOARD_FIXTURE_ID } from "../fixtures/message-board";

const repositoryRoot = resolve(import.meta.dirname, "../..");
test("message board opens through artifacts and human expansion does not stamp agent read receipts", async () => {
  const root = await mkdtemp(join(tmpdir(), "cake-message-board-smoke-"));
  const paths = {
    cakeHome: join(root, "cake-home"),
    userData: join(root, "user-data"),
    project: join(root, "project"),
  };
  let application: ElectronApplication | undefined;
  try {
    await seedMessageBoardFixture(paths);
    const receiptPath = join(
      paths.cakeHome,
      "state",
      "artifacts",
      "boards",
      createHash("sha256").update(MESSAGE_BOARD_FIXTURE_ID).digest("hex"),
      "receipts.json",
    );
    const before = await readFile(receiptPath, "utf8");
    application = await electron.launch({
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
    const page = await application.firstWindow();
    await page.setViewportSize({ width: 1500, height: 1000 });
    await expect(page.getByRole("button", { name: "1 artifacts" })).toBeVisible({ timeout: 20000 });
    await page.getByRole("button", { name: "1 artifacts" }).click();
    await page
      .getByRole("dialog", { name: "Artifacts", exact: true })
      .getByRole("button", { name: /Editor isolation/ })
      .click();
    await expect(page.getByLabel("Filter artifacts by kind")).toBeVisible();
    const board = page.locator(`[data-artifact-id="${MESSAGE_BOARD_FIXTURE_ID}"]`);
    await expect(board.getByRole("region", { name: "Workboard", exact: true })).toBeVisible();
    const finding = board.getByRole("button", { name: /^#1 · Editor isolation/ });
    await expect(finding).toBeVisible();
    await finding.focus();
    await page.keyboard.press("Enter");
    await expect(finding).toHaveAttribute("aria-expanded", "true");
    await expect(board.getByText("Finding:", { exact: true })).toBeVisible();
    await board.getByRole("button", { name: "Agent receipts for #1" }).click();
    await expect(board.getByText(/Notified: .*Read: Not recorded/)).toBeVisible();
    expect(await board.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    );
    expect(await readFile(receiptPath, "utf8")).toBe(before);
    await board.getByRole("button", { name: "View Editor isolation fullscreen" }).click();
    const fullscreen = page.getByRole("dialog", { name: "Editor isolation", exact: true });
    await expect(fullscreen.getByText("Finding:", { exact: true })).toBeVisible();
    await fullscreen.getByRole("button", { name: "Exit fullscreen Editor isolation" }).click();
    await expect(fullscreen).not.toBeAttached();
    await board.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(finding).toHaveAttribute("aria-expanded", "false");
    expect(await readFile(receiptPath, "utf8")).toBe(before);
  } finally {
    await application?.close();
    await rm(root, { recursive: true, force: true });
  }
});
