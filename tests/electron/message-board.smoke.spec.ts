import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";
import {
  seedMessageBoardFixture,
  MESSAGE_BOARD_FIXTURE_ID,
  SWITCH_BOARD_FIXTURE_ID,
} from "../fixtures/message-board";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const appendLiveEntries = (
  application: ElectronApplication,
  start: number,
  count: number,
  sessionId = "visual-workboard-member-2",
) =>
  application.evaluate(
    async (_electron, range) => {
      const append = (
        globalThis as typeof globalThis & {
          cakeSmokeAppendBoard?: (sessionId: string, input: unknown) => Promise<unknown>;
        }
      ).cakeSmokeAppendBoard;
      if (!append) throw new Error("Workboard smoke append hook unavailable");
      for (let sequence = range.start; sequence < range.start + range.count; sequence += 1)
        await append(range.sessionId, {
          description: `Live finding ${sequence}`,
          body: `Additional coordination evidence ${sequence}`,
        });
    },
    { start, count, sessionId },
  );
test("Workboards update live, preserve reading state, and reconcile after board switching and renderer disposal", async () => {
  const root = await mkdtemp(join(tmpdir(), "cake-message-board-smoke-"));
  const paths = {
    cakeHome: join(root, "cake-home"),
    userData: join(root, "user-data"),
    project: join(root, "project"),
  };
  let application: ElectronApplication | undefined;
  try {
    await seedMessageBoardFixture(paths, "dark", { secondBoard: true });
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
    await expect(page.getByRole("complementary", { name: "Artifact", exact: true })).toBeVisible();
    const board = page.locator(`[data-artifact-id="${MESSAGE_BOARD_FIXTURE_ID}"]`);
    await expect(board.getByRole("region", { name: "Workboard", exact: true })).toBeVisible();
    await expect(page.getByText("Append-only coordination log", { exact: true })).toBeVisible();
    await expect(page.getByText("Shared with workgroup", { exact: true })).toHaveCount(0);
    expect(
      await board.evaluate((element) => {
        const main = element.closest("main")!;
        return Math.abs(main.clientWidth - main.parentElement!.clientWidth) <= 1;
      }),
    ).toBe(true);
    await expect(page.getByRole("button", { name: "Copy reference", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Copy ID", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /Unlink|Link to this/ })).toHaveCount(0);
    await expect(page.getByLabel("Selected artifact revision")).toHaveCount(0);
    await expect(page.getByText("Revision history", { exact: true })).toHaveCount(0);
    await expect(page.getByText(/Revision 1 of 1|Following latest|Pinned r/)).toHaveCount(0);
    await expect(
      page.getByRole("button", {
        name: /Copy exact revision reference|Copy readable path|Pin r|Follow latest|Compare with latest|Restore as new latest/,
      }),
    ).toHaveCount(0);
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
    await appendLiveEntries(application, 4, 1);
    await expect(
      board.getByRole("button", { name: "#4 · Live finding 4", exact: true }),
    ).toBeVisible();
    await expect(finding).toHaveAttribute("aria-expanded", "true");
    await expect(board.getByText("Finding:", { exact: true })).toBeVisible();
    await expect(board.getByText(/Notified: .*Read: Not recorded/)).toBeVisible();
    expect(await readFile(receiptPath, "utf8")).toBe(before);
    await application.evaluate(async () => {
      const read = (
        globalThis as typeof globalThis & {
          cakeSmokeReadBoard?: (sessionId: string, sequence: number) => Promise<void>;
        }
      ).cakeSmokeReadBoard;
      if (!read) throw new Error("Workboard smoke read hook unavailable");
      await read("visual-workboard-member-1", 1);
    });
    await expect(board.getByText(/Notified: .*Read:/)).not.toContainText("Read: Not recorded");
    await expect(finding).toHaveAttribute("aria-expanded", "true");
    await appendLiveEntries(application, 5, 24);
    await expect(
      board.getByRole("button", { name: "#28 · Live finding 28", exact: true }),
    ).toHaveCount(1);
    const scrollTop = await board.evaluate((element) => {
      const main = element.closest("main")!;
      main.scrollTop = 250;
      return main.scrollTop;
    });
    expect(scrollTop).toBeGreaterThan(0);
    await appendLiveEntries(application, 29, 1);
    await expect(
      board.getByRole("button", { name: "#29 · Live finding 29", exact: true }),
    ).toHaveCount(1);
    expect(await board.evaluate((element) => element.closest("main")!.scrollTop)).toBe(scrollTop);
    await expect(finding).toHaveAttribute("aria-expanded", "true");

    // Browse explicitly before switching to an artifact outside the current session.
    await page.getByRole("button", { name: "1 artifacts" }).click();
    await page
      .getByRole("dialog", { name: "Artifacts", exact: true })
      .getByRole("button", { name: "Browse all artifacts" })
      .click();
    // Changing the selected descriptor ends the old board lifetime, not the window event stream.
    const lineages = page.getByRole("navigation", { name: "Artifact lineages" });
    await lineages.getByRole("button", { name: /Switchboard/ }).click();
    const otherBoard = page.locator(`[data-artifact-id="${SWITCH_BOARD_FIXTURE_ID}"]`);
    const otherFinding = otherBoard.getByRole("button", {
      name: "#1 · Switchboard finding",
      exact: true,
    });
    await expect(otherFinding).toBeVisible();
    await expect(board).not.toBeAttached();
    await otherFinding.click();
    await expect(otherBoard.getByText("Independent board evidence", { exact: true })).toBeVisible();
    await appendLiveEntries(application, 30, 1);
    await appendLiveEntries(application, 2, 1, "visual-switch-member-2");
    await expect(
      otherBoard.getByRole("button", { name: "#2 · Live finding 2", exact: true }),
    ).toBeVisible();
    await expect(otherFinding).toHaveAttribute("aria-expanded", "true");
    await expect(
      otherBoard.getByRole("button", { name: "#30 · Live finding 30", exact: true }),
    ).toHaveCount(0);
    await lineages.getByRole("button", { name: /Editor isolation/ }).click();
    await expect(finding).toBeVisible();
    await expect(finding).toHaveAttribute("aria-expanded", "false");
    await board.getByRole("button", { name: "Load more entries", exact: true }).click();
    await expect(
      board.getByRole("button", { name: "#30 · Live finding 30", exact: true }),
    ).toHaveCount(1);

    // Navigate only this isolated renderer away: the real pagehide handlers dispose its
    // observers, Stores and runtime. The backend can still append without any desktop viewer.
    const rendererUrl = page.url();
    await page.goto("about:blank");
    await expect(page.getByRole("region", { name: "Workboard", exact: true })).toHaveCount(0);
    await appendLiveEntries(application, 31, 1);
    await page.goto(rendererUrl);
    await expect(page.getByLabel("Filter artifacts by kind")).toBeVisible();
    await page
      .getByRole("navigation", { name: "Artifact lineages" })
      .getByRole("button", { name: /Editor isolation/ })
      .click();
    await expect(finding).toBeVisible();
    await board.getByRole("button", { name: "Load more entries", exact: true }).click();
    await expect(
      board.getByRole("button", { name: "#31 · Live finding 31", exact: true }),
    ).toHaveCount(1);
    await finding.click();
    await expect(board.getByText("Finding:", { exact: true })).toBeVisible();
    await appendLiveEntries(application, 32, 1);
    await expect(
      board.getByRole("button", { name: "#32 · Live finding 32", exact: true }),
    ).toHaveCount(1);
    await expect(finding).toHaveAttribute("aria-expanded", "true");
    expect(
      await application.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().every((window) => !window.isVisible() && !window.isFocused()),
      ),
    ).toBe(true);
  } finally {
    await application?.close();
    await rm(root, { recursive: true, force: true });
  }
});
