import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { findVisualCaptureScenario } from "../../scripts/visual-capture/scenarios";

const repositoryRoot = resolve(import.meta.dirname, "../..");

test("inline assistant stacks dictation underneath and reserves two input rows", async () => {
  test.setTimeout(60_000);
  const root = await mkdtemp(join(tmpdir(), "cake-composer-voice-layout-"));
  const paths = {
    cakeHome: join(root, "cake-home"),
    project: join(root, "project"),
    userData: join(root, "user-data"),
  };
  const scenario = findVisualCaptureScenario("dictation-input")!;
  await scenario.seed(paths, "dark");
  const application = await electron.launch({
    args: [repositoryRoot],
    cwd: repositoryRoot,
    env: {
      ...process.env,
      ...scenario.environment?.(paths),
      CAKE_ELECTRON_SMOKE: "1",
      CAKE_ELECTRON_USER_DATA: paths.userData,
      CAKE_HOME: paths.cakeHome,
    },
  });
  try {
    const page = await application.firstWindow();
    await scenario.prepare(page, "default", application);
    const input = page.getByRole("combobox", { name: "Message", exact: true });
    const assistant = page.locator('[data-slot="composer-leading-accessory"] button');
    await expect(assistant).toBeVisible();
    const indicator = page.locator('[data-slot="dictation-indicator"]');
    const resize = async (width: number) => {
      await application.evaluate(({ BrowserWindow }, width) => {
        BrowserWindow.getAllWindows()[0]!.setContentSize(width, 750);
      }, width);
    };
    const layout = () =>
      input.evaluate((element) => {
        const row = element.closest('[data-slot="composer-input"]')!;
        const assistant = row
          .querySelector('[data-slot="composer-leading-accessory"] button')!
          .getBoundingClientRect();
        const voice = row
          .querySelector('[data-slot="dictation-indicator"] button')!
          .getBoundingClientRect();
        const field = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return {
          stacked:
            voice.top >= assistant.bottom &&
            Math.abs(voice.left + voice.width / 2 - assistant.left - assistant.width / 2) < 1,
          voiceInside: voice.left >= field.left && voice.bottom <= field.bottom,
          twoRows:
            field.height >=
            2 * parseFloat(style.lineHeight) +
              parseFloat(style.paddingTop) +
              parseFloat(style.paddingBottom),
          indent: parseFloat(style.textIndent),
          height: field.height,
        };
      });
    await resize(1000);
    await input.fill("");
    await expect.poll(async () => (await layout()).stacked).toBe(true);
    const compact = await layout();
    expect(compact.voiceInside).toBe(true);
    expect(compact.twoRows).toBe(true);
    expect(compact.indent).toBe(0);
    await expect(input).toBeFocused();
    await input.pressSequentially("Typed in compact layout");
    await expect(input).toHaveValue("Typed in compact layout");
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
    await indicator.getByRole("button", { name: "Mute dictation", exact: true }).click();
    await expect(input).toBeFocused();
    await expect(
      indicator.getByRole("button", { name: "Unmute dictation", exact: true }),
    ).toBeVisible();
    expect(await layout()).toEqual(compact);

    await resize(1600);
    await expect.poll(async () => (await layout()).stacked).toBe(false);
    const wide = await layout();
    expect(wide.voiceInside).toBe(true);
    expect(wide.twoRows).toBe(false);
    expect(wide.indent).toBe(32);
    await expect(input).toHaveValue("Typed in compact layout");

    await resize(1000);
    await expect.poll(async () => (await layout()).stacked).toBe(true);
    expect(await layout()).toEqual(compact);
    await input.fill("First line\nSecond line\nThird line\nFourth line");
    expect((await layout()).height).toBeGreaterThan(compact.height);
    await expect(input).toBeFocused();
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
  } finally {
    await application.close();
    await rm(root, { recursive: true, force: true });
  }
});
