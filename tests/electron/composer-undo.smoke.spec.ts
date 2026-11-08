import { rm } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { dictationFixture } from "./fixtures/dictation";
import { serializeModelReference } from "../../src/contracts/model-presets/model-reference";

const modelToken = serializeModelReference({
  provider: "anthropic",
  modelId: "fixture",
  thinkingLevel: "off",
  fastMode: false,
});

test("ordinary composer supports typing, deletion, cut/paste and replacement undo/redo", async () => {
  const { root, launch } = await dictationFixture();
  const application = await launch();
  try {
    const page = await application.firstWindow();
    const composer = page.getByRole("combobox", { name: "Message Cake Chat", exact: true });
    await expect(composer).toBeVisible({ timeout: 20_000 });
    await composer.click();
    await composer.pressSequentially("Keep this draft");
    await expect(composer).toBeFocused();
    await expect(composer).toHaveValue("Keep this draft");
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
    await composer.press("Backspace");
    await expect(composer).toHaveValue("Keep this draf");
    await composer.press("ControlOrMeta+z");
    await expect(composer).toHaveValue("Keep this draft");
    await composer.press("ControlOrMeta+Shift+z");
    await expect(composer).toHaveValue("Keep this draf");
    await composer.press("ControlOrMeta+a");
    await composer.press("ControlOrMeta+x");
    await expect(composer).toHaveValue("");
    await composer.press("ControlOrMeta+z");
    await expect(composer).toHaveValue("Keep this draf");
    await composer.press("ControlOrMeta+Shift+z");
    await expect(composer).toHaveValue("");
    await composer.press("ControlOrMeta+v");
    await expect(composer).toHaveValue("Keep this draf");
    await composer.press("ControlOrMeta+z");
    await expect(composer).toHaveValue("");
    await composer.pressSequentially("Original");
    await composer.press("ControlOrMeta+z");
    await expect(composer).toHaveValue("");
    await composer.press("ControlOrMeta+Shift+z");
    await expect(composer).toHaveValue("Original");
    await composer.press("ControlOrMeta+a");
    await composer.pressSequentially("Replaced");
    await composer.press("ControlOrMeta+z");
    await expect(composer).toHaveValue("Original");
    await composer.press("ControlOrMeta+Shift+z");
    await expect(composer).toHaveValue("Replaced");
    // A different conversation gets neither this input's text nor its undo stack.
    await page.getByRole("button", { name: "Open Project Chat for project", exact: true }).click();
    const projectInput = page.getByRole("combobox", { name: "Message Project Chat", exact: true });
    await projectInput.click();
    await projectInput.press("ControlOrMeta+z");
    await expect(projectInput).toHaveValue("");
    await projectInput.pressSequentially("Project draft");
    await projectInput.press("ControlOrMeta+z");
    await expect(projectInput).toHaveValue("");
    await page.getByRole("button", { name: "Open Cake Chat", exact: true }).click();
    await expect(composer).toHaveValue("Replaced");
  } finally {
    await application.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("model-reference input undo covers cut, paste, replacement and redo", async () => {
  const { root, launch } = await dictationFixture({ modelReferences: true });
  const application = await launch();
  try {
    const page = await application.firstWindow();
    const composer = page.getByRole("combobox", { name: "Message Cake Chat", exact: true });
    await expect(composer).toBeVisible({ timeout: 20_000 });
    await composer.fill(modelToken + " Original");
    await expect(composer.getByRole("button", { name: /Edit model reference/ })).toBeVisible();
    await composer.focus();
    await composer.press("ControlOrMeta+a");
    await composer.press("ControlOrMeta+x");
    await expect(composer).toHaveText("");
    await composer.press("ControlOrMeta+z");
    await expect(composer.getByRole("button", { name: /Edit model reference/ })).toBeVisible();
    await expect(composer).toContainText("Original");
    expect(await composer.evaluate((element) => Reflect.get(element, "value"))).toBe(
      modelToken + " Original",
    );
    await composer.press("ControlOrMeta+Shift+z");
    await expect(composer).toHaveText("");
    await composer.press("ControlOrMeta+v");
    await expect(composer).toContainText("Original");
    await composer.press("ControlOrMeta+z");
    await expect(composer).toHaveText("");
    await composer.pressSequentially("A replacement");
    await composer.press("ControlOrMeta+a");
    await composer.pressSequentially("Different");
    await composer.press("ControlOrMeta+z");
    await expect(composer).toHaveText("A replacement");
    await composer.press("ControlOrMeta+Shift+z");
    await expect(composer).toHaveText("Different");
    await composer.press("Backspace");
    await composer.press("ControlOrMeta+z");
    await expect(composer).toHaveText("Different");
    await composer.press("ControlOrMeta+Shift+z");
    await expect(composer).toHaveText("Differen");
  } finally {
    await application.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("composer replacement undo restores the selected draft and groups streaming updates", async () => {
  const { root, configure, launch } = await dictationFixture({ dictationEnabled: true });
  await configure({ ready: true, speech: false, text: "" });
  const application = await launch();
  try {
    const page = await application.firstWindow();
    const composer = page.getByRole("combobox", { name: "Message Cake Chat", exact: true });
    await expect(composer).toBeVisible({ timeout: 20_000 });
    await composer.click();
    await composer.pressSequentially("Important original draft");
    await composer.press("ControlOrMeta+a");
    await configure({ ready: true, speech: true, text: "Replacement" });
    await expect(composer).toHaveValue("Replacement");
    await configure({ ready: true, speech: true, text: "Replacement complete" });
    await expect(composer).toHaveValue("Replacement complete");
    await composer.press("Escape");
    await composer.press("ControlOrMeta+z");
    await expect(composer).toHaveValue("Important original draft");
    await expect(composer).toBeFocused();
    expect(
      await composer.evaluate((element: HTMLTextAreaElement) => [
        element.selectionStart,
        element.selectionEnd,
      ]),
    ).toEqual([0, "Important original draft".length]);
    await composer.press("ControlOrMeta+Shift+z");
    await expect(composer).toHaveValue("Replacement complete");
  } finally {
    await application.close();
    await rm(root, { recursive: true, force: true });
  }
});
