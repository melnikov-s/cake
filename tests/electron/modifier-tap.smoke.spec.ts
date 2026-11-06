import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { _electron as electron } from "../../scripts/queued-electron.mjs";
import { windowState } from "../fixtures/window-state";

const repositoryRoot = resolve(import.meta.dirname, "../..");

test("records and dispatches standalone Right Option once, without intercepting typing or chords", async () => {
  const root = await mkdtemp(join(tmpdir(), "cake-modifier-tap-"));
  const userData = join(root, "user-data");
  const project = join(root, "project");
  const cakeHome = join(root, "cake-home");
  await Promise.all([
    mkdir(userData),
    mkdir(project),
    mkdir(join(cakeHome, "state"), { recursive: true }),
  ]);
  await writeFile(join(userData, "window-state.json"), windowState({ project }));
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
    const message = page.getByRole("combobox", { name: "Message", exact: true });
    await expect(message).toBeVisible({ timeout: 20_000 });
    const mod = process.platform === "darwin" ? "Meta" : "Control";
    const rightLabel = process.platform === "darwin" ? "Right Option" : "Right Alt";
    await page.keyboard.press(`${mod}+,`);
    await page.getByRole("button", { name: /^Hotkeys\b/ }).click();
    const mute = page.getByRole("button", { name: /^Toggle dictation mute shortcut/ });
    await expect(mute).toHaveText("Not assigned");
    // CDP bypasses before-input-event and sendInputEvent normalizes Alt to AltLeft on macOS.
    // Supply side-specific native inputs at that adapter boundary; real text entry stays below.
    const tap = (side: "left" | "right" = "right", chord = false) =>
      application.evaluate(
        ({ BrowserWindow }, { side, chord }) => {
          const contents = BrowserWindow.getAllWindows()[0]!.webContents;
          const emit = (type: "keyDown" | "keyUp", code: string, key: string, alt: boolean) =>
            contents.emit(
              "before-input-event",
              { preventDefault() {} },
              {
                type,
                code,
                key,
                alt,
                meta: false,
                control: false,
                shift: false,
                isAutoRepeat: false,
                isComposing: false,
              },
            );
          const code = side === "right" ? "AltRight" : "AltLeft";
          emit("keyDown", code, "Alt", true);
          if (chord) {
            emit("keyDown", "KeyE", "e", true);
            emit("keyUp", "KeyE", "e", true);
          }
          emit("keyUp", code, "Alt", false);
        },
        { side, chord },
      );
    await mute.click();
    await tap();
    await expect(mute).toHaveText(rightLabel);
    // Exercise the real native input pipeline with an observable action (no native speech build).
    const sidebarBinding = page.getByRole("button", { name: /^Toggle sidebar shortcut/ });
    await sidebarBinding.click();
    await tap();
    await expect(sidebarBinding).toHaveText(rightLabel);
    await expect(mute).toHaveText("Not assigned");
    await page.getByRole("button", { name: "Back to chat", exact: true }).click();
    const sidebar = page.locator('[data-slot="sidebar"]');
    await message.focus();
    await page.keyboard.type("typed draft");
    await expect(message).toHaveValue("typed draft");
    await tap("left");
    await expect(sidebar).toBeVisible();
    await tap("right", true);
    await expect(sidebar).toBeVisible();
    await tap();
    await expect(sidebar).toHaveCount(0);
    await expect(message).toBeFocused();
    await tap();
    await expect(sidebar).toBeVisible();
    await expect(message).not.toHaveValue("");
    // The authoritative window snapshot retains the side-specific serialization across reload.
    await expect(async () => {
      expect(JSON.parse(await readFile(join(userData, "window-state.json"), "utf8"))).toMatchObject(
        {
          data: {
            children: {
              settingsStore: {
                children: {
                  hotkeys: {
                    state: {
                      bindings: { "toggle-sidebar": "AltRight", "toggle-dictation-mute": "" },
                    },
                  },
                },
              },
            },
          },
        },
      );
    }).toPass({ timeout: 10_000 });
    await page.reload();
    await expect(message).toBeVisible();
    await tap();
    await expect(sidebar).toHaveCount(0);
    await tap();
    await expect(sidebar).toBeVisible();
  } finally {
    await application.close();
    await rm(root, { recursive: true, force: true });
  }
});
