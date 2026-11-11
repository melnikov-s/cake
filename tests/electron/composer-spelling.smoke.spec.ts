import { readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { expect, test, type Locator } from "@playwright/test";
import { dictationFixture } from "./fixtures/dictation";
import { showSessions } from "./fixtures/workspace-navigation";
import { serializeModelReference } from "../../src/contracts/model-presets/model-reference";

async function wordPosition(composer: Locator, word: string) {
  return composer.evaluate((element, word) => {
    if (element instanceof HTMLTextAreaElement) {
      const style = getComputedStyle(element);
      const context = document.createElement("canvas").getContext("2d")!;
      context.font = style.font;
      const start = element.value.indexOf(word);
      return {
        x:
          parseFloat(style.paddingLeft) +
          context.measureText(element.value.slice(0, start)).width +
          context.measureText(word).width / 2,
        y: parseFloat(style.paddingTop) + parseFloat(style.lineHeight) / 2,
      };
    }
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const start = node.textContent?.indexOf(word) ?? -1;
      if (start < 0) continue;
      const range = document.createRange();
      range.setStart(node, start);
      range.setEnd(node, start + word.length);
      const bounds = range.getBoundingClientRect();
      const input = element.getBoundingClientRect();
      return {
        x: bounds.x - input.x + bounds.width / 2,
        y: bounds.y - input.y + bounds.height / 2,
      };
    }
    throw new Error(`Missing word: ${word}`);
  }, word);
}

for (const references of [false, true]) {
  test(`native composer spelling and correction (${references ? "reference chips" : "textarea"})`, async ({}, testInfo) => {
    const server = createServer((_request, response) => {
      const chunk = (delta: object, finish_reason: string | null) =>
        `data: ${JSON.stringify({ id: "spelling", object: "chat.completion.chunk", created: 0, model: "fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        chunk({ role: "assistant", content: "Spellchecked message received." }, null) +
          chunk({}, "stop") +
          "data: [DONE]\n\n",
      );
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Fixture server unavailable");
    const { root, cakeHome, launch, sessionId } = await dictationFixture({
      modelReferences: true,
      providerUrl: `http://127.0.0.1:${address.port}/v1`,
    });
    // A usable model initializes the command catalog, without inherited credentials.
    const statePath = join(cakeHome, "state", "application.json");
    const state = JSON.parse(await readFile(statePath, "utf8"));
    state.modelPresets[0].provider = "fixture";
    state.defaultModelPresetId = state.modelPresets[0].id;
    await writeFile(statePath, JSON.stringify(state));
    const application = await launch();
    try {
      const page = await application.firstWindow();
      await application.evaluate(({ Menu, BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]!.webContents.on("context-menu", (_event, params) => {
          Reflect.set(Menu, "spellingParams", {
            word: params.misspelledWord,
            suggestions: params.dictionarySuggestions,
          });
        });
        const build = Menu.buildFromTemplate.bind(Menu);
        Reflect.set(Menu, "spellingPopups", 0);
        Menu.buildFromTemplate = (template) => {
          const menu = build(template);
          // Replace only OS presentation: dictionary results, native menu construction,
          // replacement, DOM input events and controlled draft updates remain real.
          menu.popup = (options) => {
            Reflect.set(Menu, "spellingPopups", Reflect.get(Menu, "spellingPopups") + 1);
            Reflect.set(Menu, "spellingMenu", menu);
            Reflect.set(Menu, "dismissSpellingMenu", options?.callback);
          };
          return menu;
        };
      });
      const prefix = references
        ? serializeModelReference({
            provider: "anthropic",
            modelId: "fixture",
            thinkingLevel: "off",
            fastMode: false,
          }) + " "
        : "";
      const labels = () =>
        application.evaluate(({ Menu }) =>
          Reflect.get(Menu, "spellingMenu")?.items.map(
            (item: { label: string; role?: string }) => item.role ?? item.label,
          ),
        );
      const popupCount = () =>
        application.evaluate(({ Menu }) => Reflect.get(Menu, "spellingPopups") as number);
      const choose = (label?: string) =>
        application.evaluate(({ Menu }, label) => {
          const menu = Reflect.get(Menu, "spellingMenu");
          if (label) {
            const item = menu.items.find((item: { label: string }) => item.label === label);
            if (!item) throw new Error(`Missing menu item: ${label}`);
            item.click(item);
          }
          Reflect.get(Menu, "dismissSpellingMenu")?.();
        }, label);
      const exerciseSpelling = async (composer: Locator, surface: string) => {
        await expect(composer).toBeVisible({ timeout: 20_000 });
        await composer.fill(prefix);
        await composer.click();
        await composer.evaluate((element) => {
          const input = element as HTMLTextAreaElement;
          input.setSelectionRange(input.value.length, input.value.length);
        });
        await composer.pressSequentially("A mispeling here ");
        const value = () => composer.evaluate((element) => Reflect.get(element, "value"));
        await expect.poll(value).toBe(prefix + "A mispeling here ");
        await expect(composer).toHaveAttribute("spellcheck", "true");
        await expect(composer).toHaveAttribute("autocorrect", "off");
        // These are Chromium's native red underlines, not a simulated decoration.
        await composer
          .locator("xpath=ancestor::form[1]")
          .screenshot({ path: testInfo.outputPath(`${surface}-native-spelling.png`) });
        const before = await popupCount();
        await composer.click({
          button: "right",
          position: await wordPosition(composer, "mispeling"),
        });
        await expect.poll(labels).toContain("misspelling");
        expect(await labels()).toEqual(
          expect.arrayContaining([
            "cut",
            "copy",
            "paste",
            "selectall",
            "Reword",
            "Insert model reference",
            "Insert session reference",
          ]),
        );
        expect(await popupCount()).toBe(before + 1);
        await testInfo.attach(`${surface}-native-menu`, {
          body: JSON.stringify({
            labels: await labels(),
            native: await application.evaluate(({ Menu }) => Reflect.get(Menu, "spellingParams")),
          }),
          contentType: "application/json",
        });
        await choose("misspelling");
        await expect.poll(value).toBe(prefix + "A misspelling here ");
        await composer.focus();
        await composer.press("ControlOrMeta+z");
        await expect.poll(value).toBe(prefix + "A mispeling here ");
        await expect(
          composer
            .locator("xpath=ancestor::form[1]")
            .getByRole("button", { name: "Send", exact: true }),
        ).toBeEnabled();
        await composer.fill("  /help mispeling");
        await expect(composer).toHaveAttribute("spellcheck", "false");
        await composer.click({
          button: "right",
          position: await wordPosition(composer, "mispeling"),
        });
        await expect.poll(popupCount).toBe(before + 2);
        expect(await labels()).not.toContain("misspelling");
        await choose();
        await expect.poll(value).toBe("  /help mispeling");
        await composer.fill("Spelling send check");
        await composer.press("Enter");
        await expect.poll(value).toBe("");
        await expect(
          page.getByText("Spellchecked message received.", { exact: true }).last(),
        ).toBeVisible();
        // Permanent chats materialize their command catalog on first send.
        // Side Chats intentionally expose no slash-command catalog.
        if (surface !== "side-chat") {
          await composer.pressSequentially("/mo");
          await expect.poll(value).toBe("/mo");
          await expect(page.getByRole("listbox", { name: "Slash commands" })).toBeVisible();
          await composer.press("Tab");
          await expect.poll(value).toBe("/model ");
          await expect(composer).toBeFocused();
        }
      };
      await exerciseSpelling(
        page.getByRole("combobox", { name: "Message Cake Chat", exact: true }),
        "global",
      );
      // All chat surfaces share ChatComposerInput; exercise actual routing too.
      if (!references) {
        await page
          .getByRole("button", { name: "Open Project Chat for project", exact: true })
          .click();
        await exerciseSpelling(
          page.getByRole("combobox", { name: "Message Project Chat", exact: true }),
          "project",
        );
        await showSessions(page);
        await page.locator(`[data-navigation-item][data-session-id="${sessionId}"]`).click();
        await exerciseSpelling(
          page.getByRole("combobox", { name: "Message", exact: true }),
          "session",
        );
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
        await expect.poll(labels).toContain("Chat about this");
        await choose("Chat about this");
        const side = page.getByRole("complementary", { name: "Side chat" });
        await exerciseSpelling(side.getByRole("combobox"), "side-chat");
      }
    } finally {
      await application.close();
      server.closeAllConnections();
      await new Promise<void>((done, fail) =>
        server.close((error) => (error ? fail(error) : done())),
      );
      await rm(root, { recursive: true, force: true });
    }
  });
}
