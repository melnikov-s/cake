import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { findVisualCaptureScenario } from "../../scripts/visual-capture/scenarios";

const repositoryRoot = resolve(import.meta.dirname, "../..");

test("dictation and conversation mode lead the toolbar at every width", async () => {
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
      PI_CODING_AGENT_DIR: join(paths.cakeHome, "pi"),
      PI_CODING_AGENT_SESSION_DIR: "",
    },
  });
  try {
    const page = await application.firstWindow();
    await scenario.prepare(page, "default", application);
    const input = page.getByRole("combobox", { name: "Message", exact: true });
    const indicator = page.locator(
      '[data-slot="composer-dictation"] [data-slot="dictation-indicator"]',
    );
    const mute = indicator.getByRole("button", { name: "Mute dictation", exact: true });
    const enter = page.getByRole("button", { name: "Enter conversation mode", exact: true });
    const send = page.getByRole("button", { name: "Send", exact: true });
    const resize = async (width: number) => {
      await application.evaluate(({ BrowserWindow }, width) => {
        BrowserWindow.getAllWindows()[0]!.setContentSize(width, 750);
      }, width);
    };
    const layout = () =>
      input.evaluate((element) => {
        const form = element.closest("form")!;
        const toolbar = form.querySelector('[data-slot="composer-toolbar"]')!;
        const buttons = [...toolbar.querySelectorAll("button")];
        const dictation = toolbar.querySelector('[data-slot="dictation-indicator"] button')!;
        const conversation = toolbar.querySelector('[aria-label="Conversation mode"] button')!;
        const voice = dictation.getBoundingClientRect();
        const entry = conversation.getBoundingClientRect();
        const submit = buttons.at(-1)!.getBoundingClientRect();
        const field = element.getBoundingClientRect();
        return {
          dictationFirst: buttons[0] === dictation,
          conversationAfterDictation: buttons[1] === conversation,
          conversationBeforeConfiguration:
            conversation.compareDocumentPosition(
              toolbar.querySelector('[aria-label="Model configuration"]')!,
            ) === Node.DOCUMENT_POSITION_FOLLOWING,
          toolbarAligned: Math.abs(voice.top + voice.height / 2 - entry.top - entry.height / 2) < 1,
          besideDictation: voice.right <= entry.left && entry.left - voice.right < 12,
          beforeSend: entry.right < submit.left,
          belowInput: voice.top >= field.bottom,
          indent: parseFloat(getComputedStyle(element).textIndent),
          height: field.height,
        };
      });
    for (const width of [1000, 1600, 1000]) {
      await resize(width);
      await input.fill("");
      await expect(mute).toBeVisible();
      await expect(enter).toBeVisible();
      await expect(enter).toHaveText("Voice");
      await expect.poll(async () => (await layout()).toolbarAligned).toBe(true);
      const empty = await layout();
      expect(empty).toMatchObject({
        dictationFirst: true,
        conversationAfterDictation: true,
        conversationBeforeConfiguration: true,
        besideDictation: true,
        beforeSend: true,
        belowInput: true,
        indent: 0,
      });
      await expect(input).toBeFocused();
      await input.pressSequentially("Typed with toolbar controls");
      await expect(input).toHaveValue("Typed with toolbar controls");
      await expect(send).toBeEnabled();
      await mute.click();
      await expect(input).toBeFocused();
      const unmute = indicator.getByRole("button", { name: "Unmute dictation", exact: true });
      await expect(unmute).toBeVisible();
      expect(await layout()).toEqual(empty);
      await unmute.click();
      // Portaled controls preserve the writing target during keyboard navigation too.
      await input.press("Tab");
      await expect(mute).toBeFocused();
      await mute.press("Escape");
      await expect(input).toBeFocused();
      await expect(input).toHaveValue("Typed with toolbar controls");
      await expect(unmute).toBeVisible();
      await unmute.click();
      await input.fill("First line\nSecond line\nThird line\nFourth line");
      expect((await layout()).height).toBeGreaterThan(empty.height);
      await expect(input).toBeFocused();
      await expect(send).toBeEnabled();
      await expect.poll(async () => (await layout()).belowInput).toBe(true);
    }
  } finally {
    await application.close();
    await rm(root, { recursive: true, force: true });
  }
});
