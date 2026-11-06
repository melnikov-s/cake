import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "../../scripts/queued-electron.mjs";
import { expect, test } from "@playwright/test";
import { findVisualCaptureScenario } from "../../scripts/visual-capture/scenarios";

const repositoryRoot = resolve(import.meta.dirname, "../..");

for (const dictation of [false, true]) {
  test(`companion openings and shortcut focus the input without losing drafts (dictation ${dictation})`, async () => {
    test.setTimeout(60_000);
    const root = await mkdtemp(join(tmpdir(), "cake-companion-popup-"));
    const paths = {
      cakeHome: join(root, "cake-home"),
      project: join(root, "project"),
      userData: join(root, "user-data"),
    };
    const scenario = findVisualCaptureScenario("dictation-input")!;
    await scenario.seed(paths, dictation ? "dark" : "light");
    const application = await electron.launch({
      args: [repositoryRoot],
      cwd: repositoryRoot,
      env: {
        ...process.env,
        ...scenario.environment?.(paths),
        CAKE_ELECTRON_SMOKE: "1",
        CAKE_ELECTRON_USER_DATA: paths.userData,
        CAKE_HOME: paths.cakeHome,
        PI_CODING_AGENT_DIR: join(paths.cakeHome, "pi"),
        PI_CODING_AGENT_SESSION_DIR: "",
      },
    });
    try {
      const page = await application.firstWindow();
      const parent = page.getByRole("combobox", { name: "Message", exact: true });
      await expect(parent).toBeVisible({ timeout: 20_000 });
      if (dictation) {
        await scenario.prepare(page, "default", application);
        await page.evaluate(() => {
          navigator.mediaDevices.getUserMedia = async () =>
            new AudioContext().createMediaStreamDestination().stream;
        });
      }
      const trigger = page.getByRole("button", { name: "Ask session assistant", exact: true });
      const quick = page.getByRole("dialog", { name: "Quick session assistant", exact: true });
      const input = quick.getByRole("combobox", { name: "Ask session assistant", exact: true });
      const shortcut = `${process.platform === "darwin" ? "Meta" : "Control"}+Shift+J`;
      await trigger.click();
      await expect(input).toBeFocused();
      await input.pressSequentially("A draft to keep");
      await expect(input).toHaveValue("A draft to keep");
      await expect(quick.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
      if (dictation) {
        await expect(
          quick.getByRole("button", { name: "Mute dictation", exact: true }),
        ).toBeVisible();
      } else {
        await expect(quick.locator('[data-slot="dictation-indicator"]')).toHaveCount(0);
      }
      // Neither clicking the input nor explicitly focusing another popup control closes it
      // or causes convenience autofocus to reclaim the input.
      await input.click();
      const send = quick.getByRole("button", { name: "Send", exact: true });
      await send.focus();
      await expect(send).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(input).toBeFocused();
      await input.press("Tab");
      await expect(input).toBeFocused();
      await expect(input).toHaveValue("A draft to keep");
      await page.keyboard.press(shortcut);
      await expect(input).toBeFocused();
      await expect(input).toHaveValue("A draft to keep");
      await input.press("Escape");
      await expect(quick).toHaveCount(0);
      await page.keyboard.press(shortcut);
      await expect(input).toBeFocused();
      await expect(input).toHaveValue("A draft to keep");
      await input.press("Escape");
      await expect(quick).toHaveCount(0);
      await expect(trigger).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(parent).toBeFocused();
      await trigger.click();
      await expect(input).toBeFocused();
      await expect(input).toHaveValue("A draft to keep");
      await parent.click();
      await expect(quick).toHaveCount(0);
      await trigger.click();
      await expect(input).toBeFocused();
      await expect(input).toHaveValue("A draft to keep");
      // Left-click still toggles; right-click still opens the durable full chat.
      await trigger.click();
      await expect(quick).toHaveCount(0);
      await trigger.click({ button: "right" });
      const full = page.getByRole("dialog", { name: "Session assistant chat", exact: true });
      const fullInput = full.getByRole("combobox", {
        name: "Message session assistant",
        exact: true,
      });
      await expect(fullInput).toBeFocused();
      await fullInput.pressSequentially("Full chat draft");
      await expect(fullInput).toHaveValue("Full chat draft");
      await expect(full.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
      await full.getByRole("button", { name: "Close companion", exact: true }).focus();
      await page.keyboard.press("Tab");
      await expect(fullInput).toBeFocused();
      await page.keyboard.press(shortcut);
      await expect(fullInput).toBeFocused();
      await expect(fullInput).toHaveValue("Full chat draft");
      await full.getByRole("button", { name: "Close companion", exact: true }).click();
      await expect(full).toHaveCount(0);
      await trigger.click({ button: "right" });
      await expect(fullInput).toBeFocused();
      await expect(fullInput).toHaveValue("Full chat draft");
      await fullInput.press("Escape");
      await expect(full).toHaveCount(0);
      await page.getByRole("button", { name: "Open settings", exact: true }).click();
      await page.getByRole("button", { name: /^Hotkeys\b/ }).click();
      const binding = page.getByRole("button", { name: "Open companion shortcut", exact: true });
      await expect(binding).toHaveText(process.platform === "darwin" ? "⌘⇧J" : "Ctrl+Shift+J");
      await binding.click();
      const remapped = `${process.platform === "darwin" ? "Meta" : "Control"}+Shift+K`;
      await page.keyboard.press(remapped);
      await expect(binding).toHaveText(process.platform === "darwin" ? "⌘⇧K" : "Ctrl+Shift+K");
      await page.getByRole("button", { name: "Back to chat", exact: true }).click();
      await page.keyboard.press(shortcut);
      await expect(quick).toHaveCount(0);
      await page.keyboard.press(remapped);
      await expect(input).toBeFocused();
      await expect(input).toHaveValue("A draft to keep");
    } finally {
      await application.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}
