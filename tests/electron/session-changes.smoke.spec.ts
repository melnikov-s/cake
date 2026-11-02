import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { seedSessionChanges } from "../fixtures/session-changes";

const repository = resolve(import.meta.dirname, "../..");

test("Changes toggles, expands real commit deltas, dismisses with Escape, and retains a usable composer at narrow widths", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cake-session-changes-"));
  const paths = {
    project: join(directory, "project"),
    cakeHome: join(directory, "cake"),
    userData: join(directory, "user-data"),
  };
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    await seedSessionChanges(paths);
    app = await electron.launch({
      args: [repository],
      cwd: repository,
      env: {
        ...process.env,
        CAKE_ELECTRON_SMOKE: "1",
        CAKE_HOME: paths.cakeHome,
        CAKE_ELECTRON_USER_DATA: paths.userData,
        PI_CODING_AGENT_DIR: join(paths.cakeHome, "pi"),
        PI_CODING_AGENT_SESSION_DIR: "",
      },
    });
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1440, height: 900 });
    const toggle = page.getByRole("button", { name: "Review changes · 3 commits", exact: true });
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveText("3");
    await toggle.focus();
    await page.keyboard.press("Enter");
    const panel = page.getByRole("complementary", { name: "Changes", exact: true });
    await expect(panel).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    const commit = panel.getByRole("button", { name: /Show commit history in the changes pane/ });
    await commit.focus();
    await page.keyboard.press("Space");
    await expect(commit).toHaveAttribute("aria-expanded", "true");
    const file = panel.getByRole("button", { name: /src\/review-pane.ts/ }).first();
    await expect(file).toContainText("+1");
    await expect(file).toContainText("−0");
    await expect(panel.getByRole("region", { name: "Staged", exact: true })).toContainText(
      "README.md",
    );
    await expect(panel.getByRole("region", { name: "Unstaged", exact: true })).toContainText(
      "src/session-changes.ts",
    );
    await page.setViewportSize({ width: 1000, height: 800 });
    const input = page.getByRole("combobox", { name: "Message", exact: true });
    await expect(input).toBeVisible();
    await input.click();
    await page.keyboard.type("Keep reviewing with the pane open");
    await expect(input).toBeFocused();
    await expect(input).toHaveValue("Keep reviewing with the pane open");
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
    await expect(panel).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(panel).toHaveCount(0);
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await expect(input).toBeFocused();
    await expect(input).toHaveValue("Keep reviewing with the pane open");
    await toggle.click();
    await expect(panel).toBeVisible();
    await panel.getByRole("button", { name: "Close Changes", exact: true }).click();
    await expect(panel).toHaveCount(0);
    await toggle.click();
    await toggle.click();
    await expect(panel).toHaveCount(0);
  } finally {
    await app?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
