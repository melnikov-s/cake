import { rm } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { expect, test } from "@playwright/test";
import { dictationFixture } from "./fixtures/dictation";
import { showSessions } from "./fixtures/workspace-navigation";

// Real renderer, RPC and audio worklet; fake microphone and scripted recognizer.
// This verifies capture ownership/lifecycle, not real speech recognition quality.
test("unrelated streaming preserves annotation focus, capture and user mute", async () => {
  test.setTimeout(90_000);
  let stream: ServerResponse | undefined;
  const chunk = (content: string) =>
    `data: ${JSON.stringify({
      id: "annotation-stream",
      object: "chat.completion.chunk",
      created: 0,
      model: "fixture",
      choices: [{ index: 0, delta: { content }, finish_reason: null }],
    })}\n\n`;
  const server = createServer(async (request, response) => {
    for await (const _ of request) {
      // Drain the prompt before holding its streaming response open.
    }
    stream = response;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(chunk("Unrelated stream"));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture server unavailable");
  const { root, sessionId, configure, launch } = await dictationFixture({
    dictationEnabled: true,
    providerUrl: `http://127.0.0.1:${address.port}/v1`,
  });
  await configure({ ready: true, speech: false, text: "" });
  const app = await launch();
  try {
    const page = await app.firstWindow();
    expect(page.url()).toMatch(/^file:/);
    const sessions = await showSessions(page);
    await sessions
      .locator(`.session-item[data-session-id="${sessionId}"] .session-row > button`)
      .click();
    const composer = page.getByRole("combobox", { name: "Message", exact: true });
    await expect(composer).toBeVisible({ timeout: 20_000 });
    await composer.click();
    await composer.pressSequentially("Stream while I annotate.");
    await expect(composer).toHaveValue("Stream while I annotate.");
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
    await composer.press("Enter");
    await expect(page.getByText("Unrelated stream", { exact: true })).toBeVisible();

    // Use native DOM selection and the real menu construction, replacing only its OS popup.
    await app.evaluate(({ Menu }) => {
      const build = Menu.buildFromTemplate.bind(Menu);
      Menu.buildFromTemplate = (template) => {
        const menu = build(template);
        menu.popup = (options) => {
          const item = menu.items.find((item) => item.label === "Add annotation");
          if (!item) throw new Error("Annotation action missing");
          item.click(item, options.window!, { triggeredByAccelerator: false });
          options.callback?.();
        };
        return menu;
      };
    });
    const prose = page.getByText("Inspect this implementation before changing it.", {
      exact: true,
    });
    await prose.evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    });
    await prose.dispatchEvent("contextmenu", { bubbles: true, cancelable: true });
    const draft = page.getByLabel("Annotation comment", { exact: true });
    await expect(draft).toBeFocused();
    await draft.pressSequentially("Saved note");
    stream!.write(chunk(" during draft"));
    await expect(page.getByText("Unrelated stream during draft", { exact: true })).toBeVisible();
    await expect(draft).toBeFocused();
    await expect(draft).toHaveValue("Saved note");
    await draft.press("Enter");
    await page.getByRole("button", { name: "View annotation 1", exact: true }).click();
    const details = page.getByRole("dialog", { name: "Annotation details" });
    await details.getByRole("button", { name: "Edit annotation" }).click();
    const edit = page.getByLabel("Edit annotation comment", { exact: true });
    const indicator = details.locator('[data-slot="dictation-indicator"]');
    await expect(edit).toBeFocused();
    await expect(indicator).toHaveText("Listening");
    await edit.press("End");
    await edit.pressSequentially(" typed");
    await expect(edit).toHaveValue("Saved note typed");
    // Count no-op focus calls too: activeElement alone cannot detect effect cleanup churn.
    await edit.evaluate((element: HTMLTextAreaElement) => {
      const focus = element.focus.bind(element);
      element.dataset.focusCalls = "0";
      element.focus = (options) => {
        element.dataset.focusCalls = String(Number(element.dataset.focusCalls) + 1);
        focus(options);
      };
    });
    stream!.write(chunk(" during edit"));
    await expect(
      page.getByText("Unrelated stream during draft during edit", { exact: true }),
    ).toBeVisible();
    await expect(edit).toBeFocused();
    await expect(edit).toHaveAttribute("data-focus-calls", "0");
    await expect(indicator).toHaveText("Listening");
    await configure({ ready: true, speech: true, text: "Speech during streaming" });
    await expect(edit).toHaveValue("Saved note typed Speech during streaming");
    await configure({ ready: true, speech: false, text: "Speech during streaming" });

    const save = details.getByRole("button", { name: "Save annotation", exact: true });
    await save.focus();
    stream!.write(chunk(" while parked"));
    await expect(page.getByText(/Unrelated stream.*while parked/, { exact: true })).toBeVisible();
    await expect(save).toBeFocused();
    await expect(edit).toHaveAttribute("data-focus-calls", "0");
    await expect(indicator).toHaveText("Listening");
    // Pointer mute retains field ownership; later transcript updates must not unmute it.
    await edit.focus();
    await details.getByRole("button", { name: "Mute dictation", exact: true }).click();
    await expect(edit).toBeFocused();
    stream!.write(chunk(" while muted"));
    await expect(page.getByText(/Unrelated stream.*while muted/, { exact: true })).toBeVisible();
    await expect(details.getByRole("button", { name: "Unmute dictation" })).toBeVisible();
    await expect(edit).toHaveValue("Saved note typed Speech during streaming");
  } finally {
    stream?.end("data: [DONE]\n\n");
    await app.close();
    server.closeAllConnections();
    await new Promise<void>((done, fail) =>
      server.close((error) => (error ? fail(error) : done())),
    );
    await rm(root, { recursive: true, force: true });
  }
});
