import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { findVisualCaptureScenario } from "../../scripts/visual-capture/scenarios";
import {
  defaultSpeechInputPreferences,
  speechInputControls,
} from "../../src/utils/speech-input-settings";

const repositoryRoot = resolve(import.meta.dirname, "../..");

for (const theme of ["dark", "light"] as const) {
  test(`speech input stays cohesive and responsive with keyboard controls and persisted values (${theme})`, async () => {
    const root = await mkdtemp(join(tmpdir(), "cake-speech-layout-"));
    const paths = {
      cakeHome: join(root, "cake-home"),
      project: join(root, "project"),
      userData: join(root, "user-data"),
    };
    const scenario = findVisualCaptureScenario("speech-input-settings")!;
    await scenario.seed(paths, theme);
    const application = await electron.launch({
      args: ["--force-device-scale-factor=1", repositoryRoot],
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
      const page = await application.firstWindow();
      await scenario.prepare(page, "collapsed", application);
      const section = page.getByRole("region", { name: "Speech input", exact: true });
      const disclosure = section.getByRole("button", { name: "Advanced speech input" });
      const advanced = section.getByRole("region", { name: "Advanced speech input" });
      const sensitivity = section.getByRole("slider", { name: "Speech detection sensitivity" });
      await expect(disclosure).toHaveAttribute("aria-expanded", "false");
      await expect(disclosure).toHaveAttribute("aria-controls", "advanced-voice-settings");
      await expect(advanced).toHaveCount(0);
      await expect(sensitivity).toBeVisible();
      await disclosure.focus();
      await disclosure.press("Enter");
      await expect(disclosure).toHaveAttribute("aria-expanded", "true");
      await expect(advanced).toBeVisible();
      await disclosure.press("Tab");
      const continuation = advanced.getByRole("slider", { name: "Speech continuation threshold" });
      await expect(continuation).toBeFocused();
      await continuation.press("Home");
      await expect(continuation).toHaveValue("0.05");
      await sensitivity.press("ArrowRight");
      await expect(sensitivity).toHaveValue("0.65");
      await expect(sensitivity).toHaveAttribute("aria-valuetext", "65%");
      await expect(sensitivity).toHaveAccessibleDescription(/Dictation \+ voice mode/);
      await expect(continuation).toHaveAttribute("max", "0.65");

      for (const width of [1280, 900, 800, 760]) {
        await application.evaluate(({ BrowserWindow }, width) => {
          BrowserWindow.getAllWindows()[0]!.setContentSize(width, 1100);
        }, width);
        await page.waitForFunction((width) => innerWidth === width, width);
        const geometry = await section.evaluate((element) => {
          const heading = element.querySelector("h2")!;
          const trigger = element.querySelector<HTMLButtonElement>("#advanced-voice-title")!;
          const region = element.querySelector("#advanced-voice-settings")!;
          const headingText = document.createRange();
          headingText.selectNodeContents(heading);
          const rows = [...element.querySelectorAll<HTMLInputElement>('input[type="range"]')].map(
            (slider) => {
              const controls = slider.parentElement!;
              const row = controls.parentElement!;
              const text = row.firstElementChild!;
              const bounds = row.getBoundingClientRect();
              const controlBounds = controls.getBoundingClientRect();
              const textBounds = text.getBoundingClientRect();
              const value = controls.querySelector("span")!.getBoundingClientRect();
              return {
                left: controlBounds.left,
                right: controlBounds.right,
                contained: controlBounds.left >= bounds.left && controlBounds.right <= bounds.right,
                noOverflow: [row, controls, text].every(
                  (node) => node.scrollWidth <= node.clientWidth,
                ),
                valueAligned: Math.abs(value.right - controlBounds.right) < 1,
                stacked: controlBounds.top >= textBounds.bottom,
              };
            },
          );
          return {
            headingSingleLine: headingText.getBoundingClientRect().height < 20,
            headingAboveDisclosure:
              heading.getBoundingClientRect().bottom < trigger.getBoundingClientRect().top,
            sensitivityAboveDisclosure:
              element.querySelector('input[type="range"]')!.getBoundingClientRect().bottom <
              trigger.getBoundingClientRect().top,
            sharedPanel: region.parentElement === trigger.parentElement,
            noOverflow: element.scrollWidth <= element.clientWidth,
            rows,
          };
        });
        expect(geometry.headingSingleLine).toBe(true);
        expect(geometry.headingAboveDisclosure).toBe(true);
        expect(geometry.sensitivityAboveDisclosure).toBe(true);
        expect(geometry.sharedPanel).toBe(true);
        expect(geometry.noOverflow).toBe(true);
        expect(geometry.rows).toHaveLength(speechInputControls.length);
        for (const row of geometry.rows) {
          expect(row.contained).toBe(true);
          expect(row.noOverflow).toBe(true);
          expect(row.valueAligned).toBe(true);
          expect(row.stacked).toBe(width <= 800);
          expect(row.left).toBeCloseTo(geometry.rows[0]!.left, 0);
          expect(row.right).toBeCloseTo(geometry.rows[0]!.right, 0);
        }
      }

      await disclosure.focus();
      await disclosure.press("Space");
      await expect(disclosure).toHaveAttribute("aria-expanded", "false");
      await expect(disclosure).toBeFocused();
      await expect(advanced).toHaveCount(0);
      await expect(sensitivity).toHaveValue("0.65");
      await disclosure.press("Enter");
      await expect(continuation).toHaveValue("0.05");
      const shortCommands = advanced.getByRole("switch", {
        name: "Allow short interruption commands",
      });
      await expect(shortCommands).toHaveAccessibleDescription(/Voice mode only/);
      await shortCommands.focus();
      await shortCommands.press("Space");
      await expect(shortCommands).not.toBeChecked();
      const preferences = async () => {
        const snapshot = JSON.parse(
          await readFile(join(paths.userData, "window-state.json"), "utf8"),
        );
        return snapshot.data?.children?.speechInputSettingsStore?.state?.preferences;
      };
      await expect.poll(preferences).toEqual({
        ...defaultSpeechInputPreferences,
        speechStartThreshold: 0.65,
        speechContinueThreshold: 0.05,
        shortCommands: false,
      });
      await advanced.getByRole("button", { name: "Reset speech input settings" }).click();
      for (const control of speechInputControls) {
        await expect(section.getByRole("slider", { name: control.label, exact: true })).toHaveValue(
          String(defaultSpeechInputPreferences[control.key]),
        );
      }
      await expect(shortCommands).toBeChecked();
      await expect.poll(preferences).toEqual(defaultSpeechInputPreferences);
      expect(
        await application.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().every(
            (window) => !window.isVisible() && !window.isFocused(),
          ),
        ),
      ).toBe(true);
    } finally {
      await application.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}
