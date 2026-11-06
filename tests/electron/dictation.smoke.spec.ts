import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { cakeWorkspaceSessionDirectory } from "../../src/services/pi/runtime/session-discovery";
import { store, windowStateChildren, windowStateDocument } from "../fixtures/window-state";

const repositoryRoot = resolve(import.meta.dirname, "../..");

/** Isolated profile with fake native dictation assets and a scriptable external recognizer. */
async function dictationFixture(
  options: {
    dictationEnabled?: boolean;
    preventAutomaticRefocus?: boolean;
    modelReferences?: boolean;
    providerUrl?: string;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "cake-dictation-smoke-"));
  const userData = join(root, "user-data"),
    project = join(root, "project"),
    cakeHome = join(root, "cake-home");
  const sessionId = "dictation-session";
  const sessions = cakeWorkspaceSessionDirectory(project, join(cakeHome, "pi", "sessions"));
  const dictation = join(userData, "dictation"),
    model = join(dictation, "model");
  await Promise.all([
    mkdir(sessions, { recursive: true }),
    mkdir(project, { recursive: true }),
    mkdir(join(cakeHome, "state"), { recursive: true }),
    mkdir(model, { recursive: true }),
    mkdir(join(dictation, "ctc"), { recursive: true }),
  ]);
  if (options.providerUrl)
    await writeFile(
      join(cakeHome, "pi", "models.json"),
      JSON.stringify({
        providers: {
          fixture: {
            baseUrl: options.providerUrl,
            apiKey: "fixture",
            api: "openai-completions",
            models: [
              {
                id: "fixture",
                name: "Fixture",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 128_000,
                maxTokens: 1024,
              },
            ],
          },
        },
      }),
    );
  // Fake native assets only. Never download speech models in an Electron workflow test.
  await writeFile(
    join(dictation, "ctc", "installed.json"),
    JSON.stringify({ revision: "fixture" }),
  );
  const control = join(model, "control.json");
  const configure = (value: {
    ready: boolean;
    hold?: boolean;
    holdDetection?: boolean;
    speech?: boolean;
    text?: string;
    finalText?: string;
    error?: string;
  }) => writeFile(control, JSON.stringify(value));
  await configure({ ready: false, hold: true });
  await writeFile(join(dictation, "settings.json"), JSON.stringify({ modelPath: model }));
  const helper = join(root, "cake-dictation");
  // Fake only the external native process. Real Service, RPC, Store, audio worklet and React input.
  await writeFile(
    helper,
    `#!${process.execPath}
const fs = require('node:fs'); const path = require('node:path'); const readline = require('node:readline');
const directory = process.argv[2]; const control = path.join(directory, 'control.json');
const config = () => JSON.parse(fs.readFileSync(control, 'utf8'));
const wait = (predicate) => new Promise(resolve => { const check = () => { try { if (predicate(config())) { watcher.close(); resolve(); } } catch {} }; const watcher = fs.watch(directory, check); check(); });
const reply = value => process.stdout.write(JSON.stringify(value) + '\\n');
(async () => {
  fs.appendFileSync(path.join(directory, 'starts.jsonl'), JSON.stringify({ pid: process.pid }) + '\\n');
  await wait(value => value.ready); reply({ ready: true });
  const requestPath = path.join(directory, 'request.json');
  let count = fs.existsSync(requestPath) ? JSON.parse(fs.readFileSync(requestPath, 'utf8')).count : 0;
  let finals = 0;
  for await (const line of readline.createInterface({ input: process.stdin })) {
    const request = JSON.parse(line);
    if (request.operation === 'prepareVocabulary') { reply({ prepared: true }); continue; }
    if (request.operation === 'detectSpeech') {
      if (config().holdDetection) fs.writeFileSync(path.join(directory, 'detection.json'), JSON.stringify({ held: true }));
      await wait(value => !value.holdDetection);
      const data = Buffer.from(request.pcm, 'base64'); let energy = 0; for (let i = 0; i < data.length; i += 4) energy += data.readFloatLE(i) ** 2;
      reply({ speech: config().speech ?? (data.length > 0 && Math.sqrt(energy / (data.length / 4)) > 0.003) }); continue;
    }
    fs.writeFileSync(path.join(directory, 'request.json'), JSON.stringify({ count: ++count, finals: request.final ? ++finals : finals, final: request.final, id: request.utteranceId, vocabulary: request.vocabulary }));
    await wait(value => !value.hold); const value = config(); reply(value.error ? { error: value.error } : { text: request.final ? (value.finalText ?? value.text ?? '') : (value.text ?? '') });
    fs.writeFileSync(path.join(directory, 'response.json'), JSON.stringify({ count }));
  }
})();
`,
  );
  await chmod(helper, 0o755);
  const timestamp = new Date(0).toISOString();
  await writeFile(
    join(userData, "window-state.json"),
    windowStateDocument({
      ...windowStateChildren({ project, sessionId, theme: "dark" }),
      ...(options.dictationEnabled
        ? {
            dictationStore: store({
              enabled: true,
              preventAutomaticRefocus: options.preventAutomaticRefocus ?? true,
            }),
          }
        : {}),
    }),
  );
  await writeFile(
    join(cakeHome, "state", "application.json"),
    JSON.stringify({
      schemaVersion: 1,
      projects: [{ path: project, name: "project", addedAt: timestamp, lastOpenedAt: timestamp }],
      ...(options.modelReferences
        ? {
            modelPresets: [
              {
                id: "00000000-0000-4000-8000-000000000001",
                name: "Reference fixture",
                provider: "anthropic",
                modelId: "fixture",
                thinkingLevel: "off",
                fastMode: false,
              },
            ],
          }
        : {}),
    }),
  );
  await writeFile(
    join(sessions, `1970-01-01T00-00-00-000Z_${sessionId}.jsonl`),
    [
      { type: "session", version: 3, id: sessionId, timestamp, cwd: project },
      ...(options.providerUrl
        ? [
            {
              type: "model_change",
              id: "model",
              parentId: null,
              timestamp,
              provider: "fixture",
              modelId: "fixture",
            },
          ]
        : []),
      {
        type: "message",
        id: "user-1",
        parentId: options.providerUrl ? "model" : null,
        timestamp,
        message: { role: "user", content: [{ type: "text", text: "Explain this" }], timestamp: 0 },
      },
      {
        type: "message",
        id: "assistant-1",
        parentId: "user-1",
        timestamp,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Inspect this implementation before changing it." }],
          api: options.providerUrl ? "openai-completions" : "anthropic-messages",
          provider: options.providerUrl ? "fixture" : "anthropic",
          model: "fixture",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp: 1,
        },
      },
    ]
      .map((value) => JSON.stringify(value))
      .join("\n") + "\n",
  );
  const launch = () =>
    electron.launch({
      args: [
        repositoryRoot,
        "--use-fake-ui-for-media-stream",
        "--use-fake-device-for-media-stream",
      ],
      cwd: repositoryRoot,
      env: {
        ...process.env,
        CAKE_ELECTRON_SMOKE: "1",
        CAKE_SMOKE_DICTATION_HELPER: helper,
        CAKE_ELECTRON_USER_DATA: userData,
        CAKE_HOME: cakeHome,
        PI_CODING_AGENT_DIR: join(cakeHome, "pi"),
        PI_CODING_AGENT_SESSION_DIR: "",
      },
    });
  return { root, userData, cakeHome, sessionId, dictation, model, configure, launch };
}

test("discard filters restore typed selection and preserve lowercase speech in the real composer", async () => {
  test.setTimeout(90_000);
  const { root, model, configure, launch } = await dictationFixture({ dictationEnabled: true });
  await configure({ ready: true, speech: false, text: "" });
  const application = await launch();
  try {
    const page = await application.firstWindow();
    const composer = page.getByRole("combobox", { name: "Message", exact: true });
    await expect(composer).toBeVisible({ timeout: 20_000 });
    await page.getByRole("button", { name: "Open settings", exact: true }).click();
    await page.getByRole("button", { name: /Voice & Dictation/ }).click();
    await page.getByRole("textbox", { name: "Discard phrase" }).fill("Yeah.");
    await page.getByRole("button", { name: "Add filter", exact: true }).click();
    await expect(page.getByRole("switch", { name: "Match case for Yeah." })).toBeChecked();
    await page.getByRole("button", { name: "Back to chat" }).click();
    await composer.click();
    await expect(page.locator('[data-slot="dictation-indicator"]')).toHaveText("Listening");
    await composer.pressSequentially("Typed Yeah. stays.");
    await composer.press("ControlOrMeta+a");
    await configure({ ready: true, speech: true, text: "Yeah." });
    await expect(composer).toHaveValue("Yeah.");
    await configure({ ready: true, speech: false, text: "Yeah." });
    await expect(composer).toHaveValue("Typed Yeah. stays.");
    await expect(composer).toBeFocused();
    expect(
      await composer.evaluate((element: HTMLTextAreaElement) => [
        element.selectionStart,
        element.selectionEnd,
      ]),
    ).toEqual([0, "Typed Yeah. stays.".length]);
    // Move to the tail explicitly: future ordinary speech must not be discarded.
    await composer.press("ArrowRight");
    await configure({ ready: true, speech: true, text: "yeah" });
    await expect(composer).toHaveValue("Typed Yeah. stays. yeah");
    await configure({ ready: true, speech: false, text: "yeah" });
    await expect
      .poll(async () => JSON.parse(await readFile(join(model, "request.json"), "utf8")).finals)
      .toBeGreaterThanOrEqual(2);
    await expect(composer).toHaveValue("Typed Yeah. stays. yeah");
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
  } finally {
    await application.close();
    await rm(root, { recursive: true, force: true });
  }
});

for (const draft of ["typed", "dictated"] as const) {
  test(`standalone voice command submits the ${draft} draft once without leaking command text`, async () => {
    test.setTimeout(90_000);
    const userInputs: string[] = [];
    const server = createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk;
      const payload = JSON.parse(body);
      const user = payload.messages
        ?.filter((message: { role: string }) => message.role === "user")
        .at(-1);
      userInputs.push(JSON.stringify(user?.content));
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        `data: ${JSON.stringify({
          id: "voice-submit",
          object: "chat.completion.chunk",
          created: 0,
          model: "fixture",
          choices: [{ index: 0, delta: { content: "Received the draft." }, finish_reason: "stop" }],
        })}\n\ndata: [DONE]\n\n`,
      );
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const { root, model, configure, launch } = await dictationFixture({
      dictationEnabled: true,
      providerUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    });
    await configure({ ready: true, speech: true, text: "" });
    const application = await launch();
    try {
      const page = await application.firstWindow();
      const composer = page.getByRole("combobox", { name: "Message", exact: true });
      await expect(composer).toBeVisible({ timeout: 20_000 });
      await page.getByRole("button", { name: "Open settings", exact: true }).click();
      await page.getByRole("button", { name: /Voice & Dictation/ }).click();
      await page.getByRole("switch", { name: "Submit message by voice" }).click();
      await page.getByRole("button", { name: "Back to chat" }).click();
      await composer.click();
      await expect(page.locator('[data-slot="dictation-indicator"]')).toHaveText("Listening");
      await composer.pressSequentially("Existing typed draft.");
      await expect(composer).toBeFocused();
      await expect(composer).toHaveValue("Existing typed draft.");
      await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
      let expected = "Existing typed draft.";
      if (draft === "dictated") {
        await configure({ ready: true, speech: true, text: "I might send it tomorrow." });
        expected += " I might send it tomorrow.";
        await expect(composer).toHaveValue(expected);
        await configure({ ready: true, speech: false, text: "I might send it tomorrow." });
        await expect
          .poll(async () => JSON.parse(await readFile(join(model, "request.json"), "utf8")).finals)
          .toBe(1);
        expect(userInputs).toEqual([]);
      }
      // The typed case has had no detected leading quiet at all, including during typing.
      await configure({ ready: true, speech: true, text: "Send it." });
      await expect(composer).toHaveValue(expected + " Send it.");
      expect(userInputs).toEqual([]);
      await composer.evaluate((element: HTMLTextAreaElement) => element.blur());
      await expect(composer).not.toBeFocused();
      await configure({ ready: true, speech: false, text: "  SEND IT!  " });
      await expect(composer).toHaveValue("", { timeout: 10_000 });
      await expect(page.getByText(expected, { exact: true })).toBeVisible();
      await expect(page.getByText("Received the draft.", { exact: true })).toBeVisible();
      expect(userInputs).toHaveLength(1);
      expect(userInputs[0]).toContain(expected);
      expect(userInputs[0]).not.toMatch(/Send it\.|SEND IT!/);
      await expect(page.locator('[data-slot="dictation-indicator"]')).toHaveCount(0);
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

for (const referenceKind of ["Model", "Session"] as const) {
  for (const mode of ["active-park", "active-refocus", "disabled", "muted", "stopped"] as const) {
    test(`${referenceKind} reference interaction suspends dictation and resumes only on input focus (${mode})`, async () => {
      test.skip(
        process.platform !== "darwin" || process.arch !== "arm64",
        "Parakeet installation targets Apple Silicon",
      );
      const active = mode.startsWith("active");
      const { root, configure, launch } = await dictationFixture({
        dictationEnabled: mode !== "disabled",
        preventAutomaticRefocus: mode !== "active-refocus",
        modelReferences: true,
      });
      await configure({ ready: true, speech: false, text: "" });
      const application = await launch();
      try {
        const page = await application.firstWindow();
        await expect(
          page.getByText("Inspect this implementation before changing it."),
        ).toBeVisible();
        const composer = page.getByRole("combobox", { name: "Message", exact: true });
        const indicator = page.locator(
          '[data-slot="composer-dictation"] [data-slot="dictation-indicator"]',
        );
        const reference = page.getByRole("dialog", { name: `${referenceKind} reference` });
        const configuration = page.getByRole("button", { name: "Model configuration" });
        await composer.click();
        await composer.pressSequentially("Review with ");
        await expect(composer).toHaveValue("Review with ");
        await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
        if (mode !== "disabled") await expect(indicator).toHaveText("Listening");
        if (mode === "muted") {
          await indicator.getByRole("button", { name: "Mute dictation", exact: true }).click();
          await expect(indicator).toHaveText("Dictation muted");
        } else if (mode === "stopped") {
          await composer.press("Escape");
          await expect(indicator).toHaveCount(0);
        }

        // Hold the native menu at its real RPC boundary without showing an OS popup.
        await application.evaluate(({ Menu }) => {
          const build = Menu.buildFromTemplate.bind(Menu);
          Menu.buildFromTemplate = (template) => {
            const menu = build(template);
            if (menu.items.some((item) => item.label === "Insert model reference"))
              menu.popup = (options) => {
                Reflect.set(Menu, "referenceMenu", menu);
                Reflect.set(Menu, "dismissReferenceMenu", options?.callback);
              };
            return menu;
          };
        });
        const openMenu = async () => {
          await composer.click({ button: "right" });
          await expect
            .poll(() =>
              application.evaluate(({ Menu }) => Boolean(Reflect.get(Menu, "referenceMenu"))),
            )
            .toBe(true);
          await expect(indicator).toHaveCount(0);
          await expect(composer).not.toBeFocused();
        };
        const finishMenu = async (insert: boolean) => {
          await application.evaluate(
            ({ Menu }, { select, kind }) => {
              const menu = Reflect.get(Menu, "referenceMenu");
              if (select)
                menu.items
                  .find(
                    (item: { label: string }) =>
                      item.label === `Insert ${kind.toLowerCase()} reference`,
                  )
                  .click();
              Reflect.get(Menu, "dismissReferenceMenu")?.();
              Reflect.deleteProperty(Menu, "referenceMenu");
            },
            { select: insert, kind: referenceKind },
          );
        };

        await openMenu();
        await finishMenu(true);
        await expect(reference).toBeVisible();
        await expect(indicator).toHaveCount(0);
        // Even explicit composer focus cannot restart capture while the picker is open.
        await composer.focus();
        await expect(composer).toBeFocused();
        await expect(indicator).toHaveCount(0);
        if (referenceKind === "Model") {
          await reference.getByRole("button", { name: /Reference fixture/ }).click();
          await expect(composer.getByRole("button", { name: /Edit model reference/ })).toHaveCount(
            1,
          );
        } else {
          await reference.locator('[data-slot="destination-cake-chat"]').first().click();
          await expect(composer).toHaveValue(/cake:\/\/session\//);
          await expect(
            page.getByText("Inspect this implementation before changing it."),
          ).toBeVisible();
        }
        await expect(reference).toBeHidden();
        if (active) {
          await expect(composer).toBeFocused();
          await expect(indicator).toHaveText("Listening");
          await composer.pressSequentially(" retained");
          if (referenceKind === "Model") await expect(composer).toContainText(" retained");
          else await expect(composer).toHaveValue(/ retained/);
        } else if (mode === "muted") {
          await expect(composer).toBeFocused();
          await expect(indicator).toHaveText("Dictation muted");
        } else {
          await expect(indicator).toHaveCount(0);
        }
        await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();

        if (!active) return;
        if (referenceKind === "Model") {
          // Chip dismissal anchors to the chip, not the editable input.
          await composer.getByRole("button", { name: /Edit model reference/ }).click();
          await expect(reference).toBeVisible();
          await expect(indicator).toHaveCount(0);
          await page.keyboard.press("Escape");
          await expect(reference).toBeHidden();
          await expect(indicator).toHaveCount(0);
          await composer.focus();
          await expect(indicator).toHaveText("Listening");
        }

        // Escape from an insertion picker returns to the editable anchor and resumes there.
        await openMenu();
        await finishMenu(true);
        await expect(reference).toBeVisible();
        await expect(indicator).toHaveCount(0);
        await page.keyboard.press("Escape");
        await expect(reference).toBeHidden();
        await expect(composer).toBeFocused();
        await expect(indicator).toHaveText("Listening");

        // Outside dismissal must not resume in a different control.
        await openMenu();
        await finishMenu(true);
        await expect(reference).toBeVisible();
        await configuration.click();
        await expect(reference).toBeHidden();
        await expect(indicator).toHaveCount(0);
        await page.keyboard.press("Escape");
        await composer.focus();
        await expect(indicator).toHaveText("Listening");

        // Cancelling the native menu itself leaves the blurred composer paused.
        await openMenu();
        await finishMenu(false);
        await configuration.focus();
        await expect(indicator).toHaveCount(0);
        await composer.focus();
        await expect(composer).toBeFocused();
        await expect(indicator).toHaveText("Listening");
      } finally {
        await application.close();
        await rm(root, { recursive: true, force: true });
      }
    });
  }
}

test("Dictation refocus preference applies live and survives restart", async () => {
  test.skip(process.platform !== "darwin" || process.arch !== "arm64");
  test.setTimeout(90_000);
  const { root, userData, sessionId, configure, launch } = await dictationFixture({
    dictationEnabled: true,
  });
  await configure({ ready: true, speech: false, text: "" });
  let application = await launch();
  try {
    let page = await application.firstWindow();
    const composer = () => page.getByRole("combobox", { name: "Message", exact: true });
    const anchor = () => page.getByRole("group", { name: "Press Tab to write", exact: true });
    const preference = () =>
      page.getByRole("switch", {
        name: "Prevent automatic refocusing while dictating",
      });
    const openSettings = async () => {
      await page.getByRole("button", { name: "Open settings", exact: true }).click();
      await page.getByRole("button", { name: /Voice & Dictation/ }).click();
    };
    const savedPreference = async () => {
      const document = JSON.parse(await readFile(join(userData, "window-state.json"), "utf8"));
      return document.data?.children?.dictationStore?.state?.preventAutomaticRefocus;
    };
    await expect(anchor()).toBeFocused({ timeout: 20_000 });
    await expect(composer()).not.toBeFocused();
    await openSettings();
    await expect(preference()).toBeChecked();
    await preference().click();
    await expect(preference()).not.toBeChecked();
    await page.getByRole("button", { name: "Back to chat" }).click();
    await expect(composer()).toBeFocused();
    await composer().pressSequentially("Normal automatic focus");
    await expect(composer()).toHaveValue("Normal automatic focus");
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "New chat in project", exact: true }).click();
    await expect(composer()).toBeFocused();
    await page.locator(`[data-navigation-item][data-session-id="${sessionId}"]`).click();
    await expect(composer()).toBeFocused();
    await expect(composer()).toHaveValue("Normal automatic focus");
    await expect.poll(savedPreference).toBe(false);
    await application.close();
    application = await launch();
    page = await application.firstWindow();
    await expect(composer()).toBeFocused({ timeout: 20_000 });
    await openSettings();
    await expect(preference()).not.toBeChecked();
    await preference().click();
    await expect(preference()).toBeChecked();
    await page.getByRole("button", { name: "Back to chat" }).click();
    await expect(anchor()).toBeFocused();
    await expect(composer()).not.toBeFocused();
    await expect.poll(savedPreference).toBe(true);
    await application.close();
    application = await launch();
    page = await application.firstWindow();
    await expect(anchor()).toBeFocused({ timeout: 20_000 });
    await openSettings();
    await expect(preference()).toBeChecked();
  } finally {
    await application.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Cake dictation shows readiness, types into chat and annotations, and keeps dictating across focus loss", async () => {
  test.skip(
    process.platform !== "darwin" || process.arch !== "arm64",
    "Parakeet installation targets Apple Silicon",
  );
  test.setTimeout(90_000);
  const { root, userData, cakeHome, sessionId, dictation, model, configure, launch } =
    await dictationFixture();
  let application = await launch();
  const savedEnabled = async () => {
    const document = JSON.parse(await readFile(join(userData, "window-state.json"), "utf8"));
    return document.data?.children?.dictationStore?.state?.enabled;
  };
  try {
    const page = await application.firstWindow();
    await expect(
      page.getByText("Inspect this implementation before changing it.", { exact: true }),
    ).toBeVisible({ timeout: 20_000 });
    await page.getByRole("button", { name: "Open settings", exact: true }).click();
    await page.getByRole("button", { name: /Voice & Dictation/ }).click();
    const postProcess = page.getByLabel("Text processing", { exact: true });
    await expect(postProcess).toHaveValue("raw");
    const vocabulary = join(dictation, "vocabulary.json");
    await expect(
      page.getByText("No custom words yet. Add names or company terms you use."),
    ).toBeVisible();
    await page.getByRole("button", { name: "Add word", exact: true }).click();
    const spelling = page.getByLabel("Preferred spelling", { exact: true });
    await spelling.fill("Binks");
    await page
      .getByLabel("Aliases / common misrecognitions (optional)", { exact: true })
      .fill("Banks");
    await expect(spelling).toHaveValue("Binks");
    await page.getByRole("button", { name: "Save word", exact: true }).click();
    await expect(page.getByRole("button", { name: "Edit Binks", exact: true })).toBeVisible();
    await page.getByLabel("Search custom vocabulary").fill("banks");
    await expect(page.getByRole("button", { name: "Edit Binks", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Edit Binks", exact: true }).click();
    await spelling.fill("Binx");
    await page.getByRole("button", { name: "Save word", exact: true }).click();
    await expect(page.getByRole("button", { name: "Remove Binx", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Remove Binx", exact: true }).click();
    await expect(page.getByText("No matching words or aliases.")).toBeVisible();
    await page.getByLabel("Search custom vocabulary").fill("");
    await page.getByRole("button", { name: "Add word", exact: true }).click();
    await spelling.fill("Binks");
    await page
      .getByLabel("Aliases / common misrecognitions (optional)", { exact: true })
      .fill("Banks");
    await page.getByRole("button", { name: "Save word", exact: true }).click();
    await expect(page.getByRole("button", { name: "Edit Binks", exact: true })).toBeVisible();
    expect(JSON.parse(await readFile(vocabulary, "utf8"))).toMatchObject({
      revision: 4,
      entries: [{ text: "Binks", aliases: ["Banks"] }],
    });
    await expect(postProcess).toHaveValue("raw");
    // Optional cleanup still owns the gray pending-processing overlay.
    await postProcess.selectOption("utility");
    await page.getByRole("switch", { name: "Dictation mode" }).click();
    const sample = page.getByLabel("Try dictation");
    await sample.focus();
    const indicator = page.locator('[data-slot="dictation-indicator"]');
    const loadingControl = indicator.getByRole("button", { name: "Mute dictation" });
    await expect(loadingControl).toHaveAttribute("aria-busy", "true");
    const spinner = loadingControl.locator('[role="status"]');
    await expect(spinner).toBeVisible();
    const spinnerSize = await spinner.evaluate((element) => {
      const style = getComputedStyle(element);
      return { width: parseFloat(style.width), height: parseFloat(style.height) };
    });
    expect(spinnerSize.width).toBe(12);
    expect(spinnerSize.height).toBe(12);
    await expect(indicator.locator('[aria-live="polite"]')).toHaveClass("sr-only");
    const preparingLayout = await sample.evaluate((element) => {
      const style = getComputedStyle(element);
      return { top: style.paddingTop, indent: style.textIndent };
    });
    expect(parseFloat(preparingLayout.indent)).toBeGreaterThan(24);
    await sample.pressSequentially("Typed while loading. ");
    await expect(sample).toHaveValue("Typed while loading. ");
    await expect(sample).toBeFocused();
    await configure({ ready: true, text: "Dictation is ready" });
    await expect(page.locator('[data-slot="dictation-indicator"]')).toHaveText("Listening", {
      timeout: 15_000,
    });
    await expect(sample).toHaveValue("Typed while loading. Dictation is ready");
    expect(JSON.parse(await readFile(join(model, "request.json"), "utf8")).vocabulary).toEqual([
      expect.objectContaining({ text: "Binks", aliases: ["Banks"] }),
    ]);
    await expect(loadingControl).toHaveAttribute("aria-busy", "false");
    expect(
      await sample.evaluate((element) => {
        const style = getComputedStyle(element);
        return { top: style.paddingTop, indent: style.textIndent };
      }),
    ).toEqual(preparingLayout);
    await expect(page.locator('[data-slot="provisional-text"]')).toHaveText("Dictation is ready");
    const mirrored = await sample.evaluate((element) => {
      const overlay = element.parentElement!.querySelector(
        '[data-slot="textarea-provisional-overlay"]',
      )!.firstElementChild!;
      const native = getComputedStyle(element),
        mirror = getComputedStyle(overlay);
      return {
        native: [native.paddingLeft, native.paddingTop, native.textIndent, native.lineHeight],
        mirror: [mirror.paddingLeft, mirror.paddingTop, mirror.textIndent, mirror.lineHeight],
      };
    });
    expect(mirrored.mirror).toEqual(mirrored.native);
    // Utility-mode provisional text must stay aligned with the scrolled native input.
    const provisionalSpeech = "Provisional speech that fills the writing field. ".repeat(80);
    await configure({ ready: true, text: provisionalSpeech });
    await expect(sample).toHaveValue("Typed while loading. " + provisionalSpeech.trim());
    await expect
      .poll(() =>
        sample.evaluate((element: HTMLTextAreaElement) => {
          const content = element.parentElement!.querySelector(
            '[data-slot="textarea-provisional-overlay"]',
          )!.firstElementChild!;
          return {
            atBottom:
              element.scrollTop > 0 &&
              Math.abs(element.scrollHeight - element.clientHeight - element.scrollTop) <= 1,
            aligned: new DOMMatrix(getComputedStyle(content).transform).m42 === -element.scrollTop,
          };
        }),
      )
      .toEqual({ atBottom: true, aligned: true });
    await configure({ ready: true, text: "Dictation is ready" });
    await expect(sample).toHaveValue("Typed while loading. Dictation is ready");
    const meter = page.locator(
      '[data-slot="dictation-field"]:has(textarea[aria-label="Try dictation"]) [data-slot="voice-meter"]',
    );
    await expect(meter).toBeVisible();
    await expect(meter.locator('[data-slot="voice-meter-bar"]')).toHaveCount(7);
    const circle = page.getByRole("button", { name: "Mute dictation" });
    const circleStyle = await circle.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        width: parseFloat(style.width),
        height: parseFloat(style.height),
        radius: parseFloat(style.borderRadius),
      };
    });
    expect(circleStyle.width).toBe(circleStyle.height);
    expect(circleStyle.radius).toBeGreaterThanOrEqual(circleStyle.width / 2);
    expect(await circle.locator('[data-slot="voice-meter"]').count()).toBe(1);
    // Verify real Electron layout: the meter is inside the input, not a floating popup.
    const inputBox = await sample.boundingBox();
    const meterBox = await meter.boundingBox();
    expect(inputBox).not.toBeNull();
    expect(meterBox!.x).toBeGreaterThan(inputBox!.x);
    expect(meterBox!.x - inputBox!.x).toBeLessThan(16);
    expect(meterBox!.y).toBeGreaterThan(inputBox!.y);
    expect(meterBox!.x + meterBox!.width).toBeLessThan(inputBox!.x + inputBox!.width);
    expect(meterBox!.y + meterBox!.height).toBeLessThan(inputBox!.y + inputBox!.height);
    await expect
      .poll(() =>
        meter
          .locator('[data-slot="voice-meter-bar"]')
          .evaluateAll((bars) =>
            Math.max(...bars.map((bar) => bar.getBoundingClientRect().height)),
          ),
      )
      .toBeGreaterThan(4);
    await expect(sample).toBeFocused();
    await postProcess.selectOption("raw");
    await expect(postProcess).toHaveValue("raw");
    await expect(page.locator('[data-slot="provisional-text"]')).toHaveCount(0);
    // A path/search input cannot claim speech; it does not revoke the last prose target.
    await page.getByLabel("Use an existing Core ML Parakeet model folder").focus();
    await expect(page.locator('[data-slot="dictation-indicator"]')).toHaveText("Listening");
    await expect(page.getByLabel("Use an existing Core ML Parakeet model folder")).toHaveValue("");
    await configure({ ready: true, speech: false, text: "" });
    await page.evaluate(() => {
      const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      Reflect.set(window, "dictationCaptures", 0);
      navigator.mediaDevices.getUserMedia = (...args) => {
        Reflect.set(window, "dictationCaptures", Reflect.get(window, "dictationCaptures") + 1);
        return original(...args);
      };
    });
    await page.getByRole("button", { name: "Back to chat" }).click();
    const composer = page.getByRole("combobox", { name: "Message", exact: true });
    const focusAnchor = page.getByRole("group", {
      name: "Press Tab to write",
      exact: true,
    });
    await expect(focusAnchor).toBeFocused();
    await expect(composer).not.toBeFocused();
    await expect(indicator).toHaveCount(0);
    expect(await page.evaluate(() => Reflect.get(window, "dictationCaptures"))).toBe(0);
    await page.keyboard.press("Tab");
    await expect(composer).toBeFocused();
    await expect(indicator).toHaveText("Listening");
    await page.keyboard.type("Explicitly chosen input");
    await expect(composer).toHaveValue("Explicitly chosen input");
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();

    // Blur before any speech keeps dictating into this field, not wherever focus went.
    await composer.evaluate((element: HTMLTextAreaElement) => element.blur());
    await expect(indicator).toHaveText("Listening");
    await configure({ ready: true, speech: true, text: "Spoken after blur" });
    await expect(composer).toHaveValue("Explicitly chosen input Spoken after blur");
    await composer.focus();
    // Transcript UI does not revoke the insertion either.
    await composer.evaluate((element: HTMLTextAreaElement) => element.blur());
    await page
      .getByText("Inspect this implementation before changing it.", { exact: true })
      .click();
    await expect(composer).not.toBeFocused();
    await expect(indicator).toHaveText("Listening");
    await configure({ ready: true, text: "Still listening" });
    await expect(composer).toHaveValue("Explicitly chosen input Still listening");
    await configure({ ready: true, text: "Still listening after blur" });
    await expect(composer).toHaveValue("Explicitly chosen input Still listening after blur");
    await configure({ ready: true, speech: false, text: "" });
    await composer.focus();
    await composer.fill("Explicitly chosen input");
    // Refocusing the same input continues its capture.
    await composer.evaluate((element: HTMLTextAreaElement) => element.blur());
    await expect(indicator).toHaveText("Listening");
    await composer.focus();
    await expect(indicator).toHaveText("Listening");
    // Focused Escape is a stop, not a mute or an invitation to re-arm on typing.
    await composer.press("Escape");
    await expect(indicator).toHaveCount(0);
    await composer.pressSequentially(" kept typing");
    await expect(indicator).toHaveCount(0);
    await expect(composer).toHaveValue("Explicitly chosen input kept typing");
    await composer.fill("Explicitly chosen input");
    await composer.evaluate((element: HTMLTextAreaElement) => {
      element.blur();
      element.focus();
    });
    await expect(indicator).toHaveText("Listening");

    // Detector false positives must not delete selected text or move the caret before words exist.
    await configure({ ready: true, hold: true, speech: true, text: "" });
    await composer.evaluate((element: HTMLTextAreaElement) => {
      element.setSelectionRange(11, 11);
    });
    for (let index = 0; index < 6; index++) await composer.press("Shift+ArrowRight");
    const requestCount = async () =>
      JSON.parse(await readFile(join(model, "request.json"), "utf8")).count as number;
    const beforeNoise = await requestCount();
    await configure({ ready: true, speech: true, text: "" });
    await expect.poll(requestCount).toBeGreaterThanOrEqual(beforeNoise + 2);
    await expect(composer).toHaveValue("Explicitly chosen input");
    expect(
      await composer.evaluate((element: HTMLTextAreaElement) => [
        element.selectionStart,
        element.selectionEnd,
      ]),
    ).toEqual([11, 17]);
    await configure({ ready: true, speech: true, text: "spoken" });
    await expect(composer).toHaveValue("Explicitly spoken input");
    await expect(composer).toBeFocused();
    await configure({ ready: true, speech: false, text: "" });
    await composer.fill("");

    // Temporary mute preserves typing-mode convenience focus, even across sessions.
    await page.getByRole("button", { name: "Mute dictation", exact: true }).click();
    await page.getByRole("button", { name: "New chat in project", exact: true }).click();
    await expect(composer).toBeFocused();
    await page.locator(`[data-navigation-item][data-session-id="${sessionId}"]`).click();
    await expect(composer).toBeFocused();
    await page.getByRole("button", { name: "Unmute dictation", exact: true }).click();
    await expect(indicator).toHaveText("Listening");

    // New-session mount and returning-session focus requests both park, with native Tab entry.
    await page.getByRole("button", { name: "New chat in project", exact: true }).click();
    await expect(focusAnchor).toBeFocused();
    await expect(composer).not.toBeFocused();
    await page.locator(`[data-navigation-item][data-session-id="${sessionId}"]`).click();
    await expect(focusAnchor).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(composer).toBeFocused();
    await expect(indicator).toHaveText("Listening");
    await expect(composer).toHaveValue("");
    const captures = await page.evaluate(() => Reflect.get(window, "dictationCaptures"));
    // A real DOM focus handoff must not reopen the device or rebuild its worklet.
    await composer.evaluate((element: HTMLTextAreaElement) => {
      element.blur();
      element.focus();
    });
    await expect(composer).toBeFocused();
    await expect(indicator).toHaveText("Listening");
    expect(await page.evaluate(() => Reflect.get(window, "dictationCaptures"))).toBe(captures);
    const starts = await readFile(join(model, "starts.jsonl"), "utf8");
    await composer.press("Enter");
    await expect(indicator).toHaveText("Listening");
    await expect(composer).toBeFocused();
    await expect(composer).toHaveValue("");
    expect(await page.evaluate(() => Reflect.get(window, "dictationCaptures"))).toBe(captures);
    // Cancel capture with a native detection in flight: retain the loaded helper.
    await configure({ ready: true, speech: false, text: "", holdDetection: true });
    await expect
      .poll(async () => {
        try {
          return JSON.parse(await readFile(join(model, "detection.json"), "utf8")).held;
        } catch {
          return false;
        }
      })
      .toBe(true);
    await page.getByRole("button", { name: "Open settings", exact: true }).click();
    await configure({ ready: true, speech: false, text: "" });
    await page.getByRole("button", { name: /Voice & Dictation/ }).click();
    await sample.focus();
    await expect(indicator).toHaveText("Listening");
    await page.getByRole("button", { name: "Back to chat" }).click();
    await page.locator(`[data-navigation-item][data-session-id="${sessionId}"]`).click();
    await composer.click();
    await expect(indicator).toHaveText("Listening");
    expect(await readFile(join(model, "starts.jsonl"), "utf8")).toBe(starts);
    await configure({ ready: true, hold: true });
    await composer.pressSequentially("Typed first. ");
    await expect(composer).toHaveValue("Typed first. ");
    await expect(composer).toBeFocused();
    await configure({ ready: true, text: "Spoken next." });
    await expect(composer).toHaveValue("Typed first. Spoken next.");
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
    // Dictation stays in the toolbar, separate from the input at every width.
    await application.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]!.setContentSize(1600, 900);
    });
    const composerControl = page
      .locator('[data-slot="composer-dictation"]')
      .getByRole("button", { name: "Mute dictation" });
    expect((await composerControl.boundingBox())!.y).toBeGreaterThanOrEqual(
      (await composer.boundingBox())!.y + (await composer.boundingBox())!.height,
    );
    // Growing recognition must follow the tail after the composer reaches its height cap.
    const longSpeech = "A long dictated sentence that wraps across the input. ".repeat(180);
    for (const text of [longSpeech, longSpeech + "\nThe newest dictated words."]) {
      await configure({ ready: true, text });
      await expect(composer).toHaveValue("Typed first. " + text.trim());
      await expect(composer).toBeFocused();
      await expect
        .poll(() =>
          composer.evaluate((element: HTMLTextAreaElement) => {
            const overflow = element.scrollHeight - element.clientHeight;
            return overflow > 0 && Math.abs(overflow - element.scrollTop) <= 1;
          }),
        )
        .toBe(true);
    }
    // Typing while dictation is enabled must still follow the native caret, not the tail.
    await configure({ ready: true, hold: true });
    await composer.press("Meta+ArrowUp");
    await composer.pressSequentially("Manual edit. ");
    await expect(composer).toHaveValue(/^Manual edit\. Typed first\./);
    expect(await composer.evaluate((element) => element.scrollTop)).toBe(0);
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
    // Check Chromium's actual textarea rendering: both soft wraps and explicit
    // newlines start at the same normal text inset.
    await configure({ ready: true, hold: true });
    for (const text of ["M".repeat(500), "MMMM\nMMMM"]) {
      await composer.fill(text);
      await expect(composer).toHaveValue(text);
      await expect(composer).toBeFocused();
      const screenshot = await composer.screenshot({
        caret: "hide",
        scale: "css",
        style: '[data-slot="dictation-indicator"] { visibility: hidden; }',
      });
      const positions = await composer.evaluate(async (element, png) => {
        const style = getComputedStyle(element);
        const image = new Image();
        image.src = `data:image/png;base64,${png}`;
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = image.width;
        canvas.height = image.height;
        const context = canvas.getContext("2d")!;
        context.drawImage(image, 0, 0);
        // Resolve the semantic foreground color to RGB for pixel comparison.
        context.fillStyle = style.color;
        context.fillRect(0, 0, 1, 1);
        const foreground = context.getImageData(0, 0, 1, 1).data;
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
        const top = parseFloat(style.paddingTop) + parseFloat(style.borderTopWidth);
        const lineHeight = parseFloat(style.lineHeight);
        const left = parseFloat(style.paddingLeft) + parseFloat(style.borderLeftWidth);
        const lineStarts = [0, 1].map((line) => {
          let start = canvas.width;
          for (let y = Math.ceil(top + line * lineHeight); y < top + (line + 1) * lineHeight; y++)
            for (let x = Math.floor(left); x < start; x++) {
              const offset = (y * canvas.width + x) * 4;
              if (
                [0, 1, 2].every(
                  (channel) => Math.abs(pixels[offset + channel]! - foreground[channel]!) < 30,
                )
              )
                start = x;
            }
          return start;
        });
        return { lineStarts, left, indent: parseFloat(style.textIndent) };
      }, screenshot.toString("base64"));
      expect(positions.indent).toBe(0);
      expect(positions.lineStarts[0]! - positions.left - positions.indent).toBeGreaterThanOrEqual(
        0,
      );
      expect(positions.lineStarts[0]! - positions.left - positions.indent).toBeLessThan(5);
      expect(positions.lineStarts[1]! - positions.left).toBeGreaterThanOrEqual(0);
      expect(positions.lineStarts[1]! - positions.left).toBeLessThan(5);
    }
    await composer.fill("Typed first. Spoken next.");
    // Editing while Enter is draining must cancel submission and preserve the edit.
    await configure({ ready: true, hold: true });
    await composer.press("Enter");
    await expect(page.locator('[data-slot="dictation-indicator"]')).toContainText("Finishing");
    await composer.pressSequentially(" Manual correction");
    await configure({ ready: true, text: "", finalText: "Late replacement must be discarded" });
    await expect(composer).toHaveValue("Typed first. Spoken next. Manual correction");
    await expect(composer).toBeFocused();
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
    await composer.fill("Typed first. Spoken next.");
    await expect(page.locator('[data-slot="dictation-indicator"]')).toHaveText("Listening");
    // Hold a result, leave the field, then complete it. It must not change the old draft.
    const before = JSON.parse(await readFile(join(model, "request.json"), "utf8")).count;
    await configure({ ready: true, hold: true, text: "Discard this tail" });
    await expect
      .poll(async () => JSON.parse(await readFile(join(model, "request.json"), "utf8")).count)
      .toBeGreaterThan(before);
    const heldRequest = await requestCount();
    // The owner is sticky, but Escape must stop it even when its input lacks focus.
    await composer.evaluate((element: HTMLTextAreaElement) => element.blur());
    await page.keyboard.press("Escape");
    await expect(indicator).toHaveCount(0);
    await page.getByRole("button", { name: "Open settings", exact: true }).click();
    await configure({ ready: true, text: "Discard this tail" });
    // Drain the held external reply before a later phase holds recognition again.
    await expect
      .poll(async () => JSON.parse(await readFile(join(model, "response.json"), "utf8")).count)
      .toBeGreaterThanOrEqual(heldRequest);
    await page.getByRole("button", { name: "Back to chat" }).click();
    await page.locator(`[data-navigation-item][data-session-id="${sessionId}"]`).click();
    await expect(composer).toHaveValue("Typed first. Spoken next.");
    // Kill only this fixture's external recognizer: capture recovers without refocus,
    // preserving inserted text and creating exactly one replacement native worker.
    await configure({ ready: true, hold: true });
    await composer.focus();
    await expect(page.locator('[data-slot="dictation-indicator"]')).toHaveText("Listening");
    const recoveryStarts = (await readFile(join(model, "starts.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    process.kill(recoveryStarts.at(-1).pid, "SIGKILL");
    await expect
      .poll(
        async () => (await readFile(join(model, "starts.jsonl"), "utf8")).trim().split("\n").length,
      )
      .toBe(recoveryStarts.length + 1);
    await expect(page.locator('[data-slot="dictation-indicator"]')).toHaveText("Listening");
    await expect(composer).toHaveValue("Typed first. Spoken next.");
    await expect(composer).toBeFocused();
    await composer.press("End");
    await composer.pressSequentially(" Recovery typing.");
    await expect(composer).toHaveValue("Typed first. Spoken next. Recovery typing.");
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
    await composer.fill("Typed first. Spoken next.");
    // Unclassified provider errors remain actionable, not blindly retried.
    // Recognition failure stays in the icon, without adding input padding or a status row.
    await configure({ ready: true, hold: true });
    await composer.focus();
    await expect(page.locator('[data-slot="dictation-indicator"]')).toHaveText("Listening");
    const fieldLayout = () =>
      composer.evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          inputHeight: element.getBoundingClientRect().height,
          frameHeight: element.closest("form")!.getBoundingClientRect().height,
          paddingTop: style.paddingTop,
          indent: style.textIndent,
        };
      });
    const listeningLayout = await fieldLayout();
    await configure({ ready: true, error: "Speech engine stopped" });
    const errorStatus = page.locator('[data-slot="dictation-indicator"] [aria-live="polite"]');
    await expect(errorStatus).toHaveText("Speech engine stopped");
    await expect(errorStatus).toHaveClass("sr-only");
    const errorControl = page.getByRole("button", { name: "Retry dictation", exact: true });
    await expect(errorControl).toHaveClass(/text-destructive/);
    expect(await fieldLayout()).toEqual(listeningLayout);
    await errorControl.hover();
    await expect(page.getByRole("tooltip")).toContainText("Speech engine stopped");
    await composer.focus();
    await composer.press("End");
    await composer.pressSequentially(" Still writable.");
    await expect(composer).toHaveValue("Typed first. Spoken next. Still writable.");
    await expect(composer).toBeFocused();
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
    await configure({ ready: true, hold: true });
    await errorControl.click();
    await expect(page.locator('[data-slot="dictation-indicator"]')).toHaveText("Listening");
    await composer.fill("Typed first. Spoken next.");
    // Select transcript prose and exercise the real native context-menu path.
    await configure({ ready: true, hold: true });
    const prose = page.getByText("Inspect this implementation before changing it.", {
      exact: true,
    });
    await prose.evaluate((element) => {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(element);
      selection?.removeAllRanges();
      selection?.addRange(range);
    });
    await application.evaluate(({ Menu }) => {
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
    await prose.dispatchEvent("contextmenu", { bubbles: true, cancelable: true });
    const annotation = page.getByLabel("Annotation comment");
    await expect(annotation).toBeFocused();
    const annotationText = "Typed: Is this a question that I should be asking?";
    await annotation.pressSequentially("Typed:");
    await expect(annotation).toHaveValue("Typed:");
    await expect(annotation).toBeFocused();
    await configure({ ready: true, text: "Is this a question that I should?" });
    await expect(annotation).toHaveValue("Typed: Is this a question that I should?");
    await configure({ ready: true, text: "Is this a question that I should be asking?" });
    await expect(annotation).toHaveValue(annotationText);
    await expect(annotation).toBeFocused();
    await annotation.press("Enter");
    await expect(page.getByRole("dialog", { name: "Add annotation" })).toHaveCount(0);
    await configure({ ready: true, hold: true });
    await prose.evaluate((element) => {
      const range = document.createRange();
      const text = document.createTreeWalker(element, NodeFilter.SHOW_TEXT).nextNode();
      if (!text) throw new Error("Transcript text missing");
      range.setStart(text, 0);
      range.setEnd(text, "Inspect".length);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    });
    await prose.dispatchEvent("contextmenu", { bubbles: true, cancelable: true });
    await expect(annotation).toBeFocused();
    await annotation.pressSequentially("Second note");
    await configure({ ready: true, text: "Second annotation speech" });
    await expect(annotation).toHaveValue("Second note Second annotation speech");
    await annotation.press("Enter");
    await expect(annotation).toHaveCount(0);
    await configure({ ready: true, speech: false, text: "" });
    await page.getByRole("button", { name: "View annotation 1", exact: true }).click();
    await expect(page.getByText(annotationText, { exact: true })).toBeVisible();
    const details = page.getByRole("dialog", { name: "Annotation details" });
    await details.getByRole("button", { name: "Edit annotation" }).click();
    const edit = page.getByLabel("Edit annotation comment");
    await expect(edit).toBeFocused();
    await edit.press("End");
    await details.getByRole("button", { name: "Save annotation", exact: true }).focus();
    await expect(edit).not.toBeFocused();
    await expect(indicator).toHaveText("Listening");
    await edit.focus();
    await configure({ ready: true, speech: true, text: "First focused words" });
    await expect(edit).toHaveValue(annotationText + " First focused words");
    await details.getByRole("button", { name: "Save annotation", exact: true }).focus();
    await expect(indicator).toHaveText("Listening");
    await configure({ ready: true, text: "Continued off focus" });
    await expect(edit).toHaveValue(annotationText + " Continued off focus");
    await configure({ ready: true, hold: true });
    await composer.click();
    await expect(details).toHaveCount(0);
    await expect(composer).toBeFocused();
    await composer.press("End");
    await configure({ ready: true, text: "Composer after annotation" });
    await expect(composer).toHaveValue("Typed first. Spoken next. Composer after annotation");
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
    await configure({ ready: true, hold: true });
    await page.getByRole("button", { name: "View annotation 2", exact: true }).click();
    await expect(
      page.getByText("Second note Second annotation speech", { exact: true }),
    ).toBeVisible();
    await details.getByRole("button", { name: "Edit annotation" }).click();
    await expect(edit).toHaveValue("Second note Second annotation speech");
    await expect(edit).toBeFocused();
    await expect(page.getByRole("button", { name: "Mute dictation" })).toBeVisible();
    await page.getByRole("button", { name: "Mute dictation", exact: true }).click();
    await expect(page.getByRole("button", { name: "Unmute dictation" })).toBeVisible();
    await expect(edit).toBeFocused();
    await expect(details).toBeVisible();
    await edit.pressSequentially(" typed instead");
    await expect(edit).toHaveValue(/ typed instead$/);
    await edit.evaluate((element: HTMLTextAreaElement) => element.blur());
    await edit.focus();
    await expect(page.getByRole("button", { name: "Unmute dictation" })).toBeVisible();
    await page.getByRole("button", { name: "Unmute dictation" }).click();
    await expect(page.getByRole("button", { name: "Mute dictation" })).toBeVisible();
    await expect(edit).toBeFocused();
    await page.getByRole("button", { name: "Mute dictation" }).click();
    await expect(edit).toBeFocused();
    await expect(details).toBeVisible();
    await expect(page.getByRole("button", { name: "Unmute dictation" })).toBeVisible();
    await edit.press("Escape");
    await expect(edit).toHaveCount(0);
    await expect(details).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(details).toHaveCount(0);

    // Optional voice submission uses Settings' shared stable-target navigation/highlight
    // path and an actual pause boundary, never recognizer packet boundaries.
    await page.getByRole("button", { name: "View 2 annotations", exact: true }).click();
    await page.getByRole("button", { name: "Remove annotation 2", exact: true }).click();
    await page.getByRole("button", { name: "Remove annotation 1", exact: true }).click();
    await page.getByRole("button", { name: "Open settings", exact: true }).click();
    await page.getByRole("button", { name: /Voice & Dictation/ }).click();
    await page.getByRole("searchbox", { name: "Search settings" }).fill("Submit message by voice");
    await page.getByRole("button", { name: "Submit message by voice", exact: true }).click();
    await expect(page.locator("#setting-dictation-voice-submit")).toHaveAttribute(
      "data-settings-highlighted",
      "true",
    );
    await page.getByRole("searchbox", { name: "Search settings" }).fill("");
    const voiceSend = page.getByRole("switch", { name: "Submit message by voice" });
    await expect(voiceSend).not.toBeChecked();
    await voiceSend.click();
    await expect(page.getByLabel("Submit phrase", { exact: true })).toHaveValue("send it");
    await page.getByLabel("Submit phrase", { exact: true }).fill("over and out");
    await configure({ ready: true, speech: true, text: "" });
    await page.getByRole("button", { name: "Back to chat" }).click();
    await composer.focus();
    await composer.fill("");
    await page.getByRole("button", { name: "Unmute dictation" }).click();
    await expect(composer).toBeFocused();
    const beforeVoice = await requestCount();
    await expect.poll(requestCount).toBeGreaterThanOrEqual(beforeVoice + 2);
    const finalCount = async () =>
      JSON.parse(await readFile(join(model, "request.json"), "utf8")).finals as number;
    const beforePause = await finalCount();
    await configure({ ready: true, speech: false, text: "" });
    await expect.poll(finalCount, { timeout: 10_000 }).toBeGreaterThan(beforePause);
    await configure({ ready: true, speech: true, text: "over and out" });
    await expect(composer).toHaveValue("over and out"); // interim never sends
    await composer.evaluate((element: HTMLTextAreaElement) => element.blur());
    await page
      .getByText("Inspect this implementation before changing it.", { exact: true })
      .click();
    await expect(composer).not.toBeFocused();
    await configure({ ready: true, speech: false, text: "  “OVER AND OUT.”  " });
    // Ordinary empty Send is rejected; the matched command is still removed, not submitted.
    await expect(composer).toHaveValue("", { timeout: 10_000 });
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "Mute dictation" }).click();
    await page.getByRole("button", { name: "Open settings", exact: true }).click();
    await page.getByRole("button", { name: /Voice & Dictation/ }).click();
    await voiceSend.click();
    await expect(voiceSend).not.toBeChecked();
    await page.getByRole("button", { name: "Back to chat" }).click();
    await page.getByRole("button", { name: "Open settings", exact: true }).click();
    await page.getByRole("button", { name: /Voice & Dictation/ }).click();
    await page.getByLabel("Text processing", { exact: true }).selectOption("raw");
    await expect(page.getByRole("switch", { name: "Dictation mode" })).toBeChecked();
    await sample.focus();
    const unmute = page.getByRole("button", { name: "Unmute dictation" });
    const mute = page.getByRole("button", { name: "Mute dictation" });
    await expect(unmute).toBeVisible();
    await expect(unmute).toHaveAttribute("aria-pressed", "true");
    await sample.fill("Kept text");
    // Keyboard focus into the circle must not remove it or lose its writing target.
    await unmute.focus();
    await unmute.press("Enter");
    await expect(sample).toBeFocused();
    await expect(mute).toHaveAttribute("aria-pressed", "false");
    await configure({ ready: true, text: "Speech after unmuting" });
    await expect(sample).toHaveValue("Kept text Speech after unmuting");
    await mute.click();
    await expect(sample).toBeFocused();
    await expect(unmute).toHaveAttribute("aria-pressed", "true");
    await sample.pressSequentially(" typed while muted");
    await expect(sample).toHaveValue("Kept text Speech after unmuting typed while muted");
    await expect(page.getByRole("switch", { name: "Dictation mode" })).toBeChecked();
    await page.getByLabel("Use an existing Core ML Parakeet model folder").focus();
    await sample.focus();
    await expect(unmute).toBeVisible();
    await unmute.focus();
    await unmute.press("Space");
    await expect(sample).toBeFocused();
    await expect(mute).toBeVisible();
    await mute.click();
    await expect(unmute).toHaveAttribute("aria-pressed", "true");
    await expect.poll(savedEnabled).toBe(true);
    await application.close();
    // The relaunched window preloads the engine before any field asks; it stays loading here.
    const engineStarts = async () =>
      (await readFile(join(model, "starts.jsonl"), "utf8")).trim().split("\n").length;
    const startsBeforeRelaunch = await engineStarts();
    await configure({ ready: false, speech: false, text: "" });
    application = await launch();
    const restarted = await application.firstWindow();
    await expect.poll(engineStarts, { timeout: 15_000 }).toBe(startsBeforeRelaunch + 1);
    // Settings and enablement are restored; temporary mute is not.
    await restarted.getByRole("button", { name: /Voice & Dictation/ }).click();
    const restartedMode = restarted.getByRole("switch", { name: "Dictation mode" });
    await expect(restartedMode).toBeChecked();
    await expect(restarted.getByLabel("Text processing", { exact: true })).toHaveValue("raw");
    const restartedSample = restarted.getByLabel("Try dictation");
    await restartedSample.focus();
    const restartedControl = restarted.getByRole("button", { name: "Mute dictation" });
    await expect(restartedControl).toHaveAttribute("aria-pressed", "false");
    await expect(restartedControl).toHaveAttribute("aria-busy", "true");
    // Preload completion reaches the field that is still focused, with no refocus or reload.
    await configure({ ready: true, speech: false, text: "" });
    await expect(restarted.locator('[data-slot="dictation-indicator"]')).toHaveText("Listening", {
      timeout: 15_000,
    });
    await expect(restartedControl).toHaveAttribute("aria-busy", "false");
    await expect(restartedSample).toBeFocused();
    expect(await engineStarts()).toBe(startsBeforeRelaunch + 1);
    // The relaunched attempt's steps reach Cake's on-disk desktop log under one attempt ID.
    const loggedSteps = async () =>
      (await readFile(join(cakeHome, "logs", "desktop.log"), "utf8").catch(() => ""))
        .split("\n")
        .filter((line) => line.includes('"Dictation step"'))
        .map(
          (line) =>
            JSON.parse(line).message[1] as { attempt: string; step: string; reason?: string },
        );
    const stepsOf = async (first: (line: { step: string; reason?: string }) => boolean) => {
      const lines = await loggedSteps();
      const attempt = lines.findLast(first)?.attempt;
      return lines.filter((line) => line.attempt === attempt).map(({ step }) => step);
    };
    const restartedSteps = () => stepsOf(({ step }) => step === "listening");
    await expect
      .poll(() =>
        stepsOf(({ step, reason }) => step === "model-load-requested" && reason === "launch"),
      )
      .toEqual(["model-load-requested", "model-load-finished"]);
    await expect
      .poll(restartedSteps)
      .toEqual(
        expect.arrayContaining([
          "start-requested",
          "model-load-requested",
          "model-load-finished",
          "mic-open-requested",
          "mic-opened",
          "listening",
        ]),
      );
    await restartedMode.click();
    await expect(restartedMode).not.toBeChecked();
    await expect.poll(savedEnabled).toBe(false);
    await application.close();
    application = await launch();
    const disabled = await application.firstWindow();
    await disabled.getByRole("button", { name: /Voice & Dictation/ }).click();
    await expect(disabled.getByRole("switch", { name: "Dictation mode" })).not.toBeChecked();
    await disabled.getByLabel("Try dictation").focus();
    await expect(disabled.locator('[data-slot="dictation-indicator"]')).toHaveCount(0);
    expect(await engineStarts()).toBe(startsBeforeRelaunch + 1);
  } finally {
    await application.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Cake composer dictation keeps capturing while Cake's page lacks OS focus", async () => {
  test.skip(
    process.platform !== "darwin" || process.arch !== "arm64",
    "Parakeet installation targets Apple Silicon",
  );
  test.setTimeout(60_000);
  const { root, configure, launch } = await dictationFixture({ dictationEnabled: true });
  await configure({ ready: true, speech: false, text: "" });
  const application = await launch();
  try {
    const page = await application.firstWindow();
    const composer = page.getByRole("combobox", { name: "Message", exact: true });
    const indicator = page.locator('[data-slot="dictation-indicator"]');
    await expect(composer).toBeVisible({ timeout: 20_000 });
    await page.evaluate(() => {
      const events: string[] = [];
      Reflect.set(window, "focusEvents", events);
      window.addEventListener("blur", () => events.push("window-blur"));
      document.addEventListener("focusout", () => events.push("field-blur"), true);
      const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      Reflect.set(window, "dictationCaptures", 0);
      navigator.mediaDevices.getUserMedia = (...args) => {
        Reflect.set(window, "dictationCaptures", Reflect.get(window, "dictationCaptures") + 1);
        return original(...args);
      };
    });
    // DOM focus only. CDP keyboard or mouse input would grant this hidden window Chromium
    // page focus, which it then could not lose without showing the window.
    await composer.focus();
    await expect(indicator).toHaveText("Listening", { timeout: 15_000 });
    // The hidden, natively unfocused window is the state Cake's page is in while another app,
    // the desktop, Browser Mode's page or the VS Code panel has focus. Disabling focus
    // emulation exposes it: Chromium blurs the field, then the window, before any speech.
    await page.evaluate(() => (Reflect.get(window, "focusEvents") as string[]).splice(0));
    const focusEmulation = await page.context().newCDPSession(page);
    await focusEmulation.send("Emulation.setFocusEmulationEnabled", { enabled: false });
    await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(false);
    expect(await page.evaluate(() => Reflect.get(window, "focusEvents"))).toEqual([
      "field-blur",
      "window-blur",
    ]);
    expect(
      await application.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().every((window) => !window.isVisible()),
      ),
    ).toBe(true);
    await expect(indicator).toHaveText("Listening");
    await configure({ ready: true, speech: true, text: "Spoken while away" });
    await expect(composer).toHaveValue("Spoken while away");
    // Returning continues the same insertion on the same device.
    await focusEmulation.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(true);
    await expect(composer).toBeFocused();
    await configure({ ready: true, speech: true, text: "Spoken while away and back" });
    await expect(composer).toHaveValue("Spoken while away and back");
    await expect(indicator).toHaveText("Listening");
    expect(await page.evaluate(() => Reflect.get(window, "dictationCaptures"))).toBe(1);
  } finally {
    await application.close();
    await rm(root, { recursive: true, force: true });
  }
});
