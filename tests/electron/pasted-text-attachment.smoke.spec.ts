import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { windowState } from "../fixtures/window-state";

const repositoryRoot = resolve(import.meta.dirname, "../..");

function chunk(delta: object, finishReason: string | null = null) {
  return `data: ${JSON.stringify({
    id: "paste-fixture",
    object: "chat.completion.chunk",
    created: 0,
    model: "fixture-model",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;
}

test("preserves paste focus and caret through attachments and opens the sent text", async () => {
  test.setTimeout(90_000);
  const temporaryRoot = await mkdtemp(join(tmpdir(), "cake-pasted-text-"));
  const userData = join(temporaryRoot, "user-data");
  const project = join(temporaryRoot, "project");
  const cakeHome = join(temporaryRoot, "cake-home");
  const server = createServer(async (request, response) => {
    if (request.method === "GET") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ object: "list", data: [{ id: "fixture-model", object: "model" }] }),
      );
      return;
    }
    await new Promise((resolve) => request.on("end", resolve).resume());
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(
      chunk({ role: "assistant", content: "Read it." }) + chunk({}, "stop") + "data: [DONE]\n\n",
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a TCP server");
  await Promise.all([
    mkdir(userData, { recursive: true }),
    mkdir(project, { recursive: true }),
    mkdir(join(cakeHome, "pi"), { recursive: true }),
    mkdir(join(cakeHome, "state"), { recursive: true }),
  ]);
  await writeFile(
    join(cakeHome, "pi", "models.json"),
    JSON.stringify({
      providers: {
        "paste-provider": {
          name: "Paste provider",
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          apiKey: "fixture",
          api: "openai-completions",
          models: [
            {
              id: "fixture-model",
              name: "Paste fixture",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 128_000,
              maxTokens: 8_192,
            },
          ],
        },
      },
    }),
  );
  await writeFile(join(userData, "window-state.json"), windowState({ project, theme: "dark" }));
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
      trustedProjectPaths: [project],
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
    await page.getByRole("button", { name: "Model configuration" }).click({ timeout: 20_000 });
    await page.getByLabel("Search presets and models").fill("Paste fixture");
    await page
      .getByRole("button", { name: /Paste fixture/ })
      .first()
      .click();
    await page.getByRole("button", { name: "Apply", exact: true }).click();
    const composer = page.getByRole("combobox", { name: "Message", exact: true });
    await composer.click();
    await expect(composer).toBeFocused();
    const pasted = "FIRST_PASTED_LINE\n" + "middle line\n".repeat(88) + "LAST_PASTED_LINE";
    await composer.evaluate((element, text) => {
      const clipboardData = new DataTransfer();
      clipboardData.setData("text/plain", text);
      element.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }),
      );
    }, pasted);
    await expect(page.getByRole("button", { name: /^Pasted text/ })).toBeVisible();
    await expect(composer).toBeFocused();
    await page.keyboard.type("Review this paste");
    await expect(composer).toHaveValue("Review this paste");
    const send = page.getByRole("button", { name: "Send", exact: true });
    await expect(send).toBeEnabled();

    // A paste must not enqueue autofocus that overrides the next deliberate focus change.
    await composer.evaluate((element, text) => {
      const clipboardData = new DataTransfer();
      clipboardData.setData("text/plain", text);
      element.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }),
      );
      (element.closest("form")!.querySelector('[aria-label="Send"]') as HTMLElement).focus();
    }, pasted + "\nAnother line");
    await expect(page.getByRole("button", { name: /^Remove Pasted text/ })).toHaveCount(2);
    await page.evaluate(() =>
      new Promise(requestAnimationFrame).then(() => new Promise(requestAnimationFrame)),
    );
    await expect(send).toBeFocused();
    await page
      .getByRole("button", { name: /^Remove Pasted text/ })
      .last()
      .click();

    const pixel =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9XkAAAAASUVORK5CYII=";
    const otherControl = page.getByRole("button", { name: "Model configuration", exact: true });
    for (const moveFocus of [false, true]) {
      await composer.fill("before after");
      // Delay only the external file read; conversion, Store updates and rendering stay real.
      const readGate = await page.evaluateHandle(() => {
        const original = FileReader.prototype.readAsDataURL;
        let resume: (() => void) | undefined;
        FileReader.prototype.readAsDataURL = function (blob) {
          resume = () => original.call(this, blob);
        };
        return {
          release() {
            FileReader.prototype.readAsDataURL = original;
            if (!resume) throw new Error("Expected a pending image read");
            resume();
          },
        };
      });
      try {
        await composer.evaluate((element: HTMLTextAreaElement, data) => {
          element.setSelectionRange(7, 7);
          const clipboardData = new DataTransfer();
          clipboardData.items.add(
            new File([Uint8Array.from(atob(data), (c) => c.charCodeAt(0))], "pixel.png", {
              type: "image/png",
            }),
          );
          element.dispatchEvent(
            new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }),
          );
        }, pixel);
        await expect(send).toBeDisabled();
        await expect(composer).toBeFocused();
        expect(
          await composer.evaluate((element: HTMLTextAreaElement) => [
            element.selectionStart,
            element.selectionEnd,
          ]),
        ).toEqual([7, 7]);
        // Real keyboard input while conversion is still pending must not be overwritten.
        await page.keyboard.type("typed ");
        if (moveFocus) await otherControl.focus();
        await readGate.evaluate((gate) => gate.release());
        await expect(page.getByAltText("pixel.png", { exact: true })).toHaveAttribute(
          "src",
          `data:image/png;base64,${pixel}`,
        );
        await expect(send).toBeEnabled();
        if (moveFocus) {
          await expect(otherControl).toBeFocused();
        } else {
          await expect(composer).toBeFocused();
          await page.keyboard.type("more ");
        }
        await expect(composer).toHaveValue(
          moveFocus ? "before typed after" : "before typed more after",
        );
      } finally {
        await readGate.dispose();
      }
      await page.getByRole("button", { name: "Remove pixel.png", exact: true }).click();
    }
    await composer.fill("Review this paste");
    await send.click();
    await expect(page.getByText("Read it.", { exact: true })).toBeVisible({ timeout: 20_000 });
    const conversation = page.getByLabel("Conversation", { exact: true });
    const badge = conversation.getByText("Pasted text · 90 lines", { exact: true });
    await expect(badge).toHaveCount(1);
    await badge.click();
    const viewer = page.getByRole("dialog", { name: "Pasted text · 90 lines" });
    await expect(viewer).toBeVisible({ timeout: 5_000 });
    await expect(viewer).toContainText("FIRST_PASTED_LINE");
    await expect(viewer).toContainText("LAST_PASTED_LINE");
    await page.keyboard.press("Escape");

    // The permanent chat consumes the same draft/composer implementation.
    await page.getByRole("button", { name: "Cake Chat", exact: true }).click();
    const cakeInput = page.getByRole("combobox", { name: "Message Cake Chat", exact: true });
    await cakeInput.click();
    await cakeInput.evaluate((element, text) => {
      const clipboardData = new DataTransfer();
      clipboardData.setData("text/plain", text);
      element.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }),
      );
    }, pasted);
    await expect(page.getByRole("button", { name: /^Pasted text/ })).toBeVisible();
    await expect(cakeInput).toBeFocused();
    await page.keyboard.type("Continue typing");
    await expect(cakeInput).toHaveValue("Continue typing");
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
  } finally {
    await application.close();
    server.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
