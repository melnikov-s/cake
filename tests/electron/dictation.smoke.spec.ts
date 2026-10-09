import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { cakeWorkspaceSessionDirectory } from "../../src/services/pi/runtime/session-discovery";

const repositoryRoot = resolve(import.meta.dirname, "../..");

test("Cake dictation shows readiness, types into chat and annotations, and seals focus boundaries", async () => {
  test.skip(
    process.platform !== "darwin" || process.arch !== "arm64",
    "Parakeet installation targets Apple Silicon",
  );
  test.setTimeout(90_000);
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
  ]);
  // Optional real local CPU model, supplied explicitly; no test downloads weights.
  const localRoot = process.env.CAKE_PUNCTUATION_TEST_ROOT;
  if (localRoot) {
    const punctuationModel = join(dictation, "punctuation", "model");
    await mkdir(punctuationModel, { recursive: true });
    await cp(
      join(localRoot, "model", "punct_cap_seg_en.onnx"),
      join(punctuationModel, "punct_cap_seg_en.onnx"),
    );
  }
  const control = join(model, "control.json");
  const configure = (value: {
    ready: boolean;
    hold?: boolean;
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
  await wait(value => value.ready); reply({ ready: true });
  const requestPath = path.join(directory, 'request.json');
  let count = fs.existsSync(requestPath) ? JSON.parse(fs.readFileSync(requestPath, 'utf8')).count : 0;
  for await (const line of readline.createInterface({ input: process.stdin })) {
    const request = JSON.parse(line);
    if (request.operation === 'detectSpeech') { const data = Buffer.from(request.pcm, 'base64'); let energy = 0; for (let i = 0; i < data.length; i += 4) energy += data.readFloatLE(i) ** 2; reply({ speech: data.length > 0 && Math.sqrt(energy / (data.length / 4)) > 0.003 }); continue; }
    fs.writeFileSync(path.join(directory, 'request.json'), JSON.stringify({ count: ++count, final: request.final, id: request.utteranceId }));
    await wait(value => !value.hold); const value = config(); reply(value.error ? { error: value.error } : { text: request.final ? (value.finalText ?? value.text ?? '') : (value.text ?? '') });
  }
})();
`,
  );
  await chmod(helper, 0o755);
  const timestamp = new Date(0).toISOString();
  await writeFile(
    join(userData, "window-state.json"),
    JSON.stringify({
      projectPath: project,
      selectedSessionId: sessionId,
      activeConversation: { kind: "project-session", workspacePath: project, sessionId },
      recentProjectPaths: [project],
      draft: "",
      theme: "dark",
      draftsBySession: {},
    }),
  );
  await writeFile(
    join(cakeHome, "state", "application.json"),
    JSON.stringify({
      schemaVersion: 1,
      projects: [{ path: project, name: "project", addedAt: timestamp, lastOpenedAt: timestamp }],
      trustedProjectPaths: [],
    }),
  );
  await writeFile(
    join(sessions, `1970-01-01T00-00-00-000Z_${sessionId}.jsonl`),
    [
      { type: "session", version: 3, id: sessionId, timestamp, cwd: project },
      {
        type: "message",
        id: "user-1",
        parentId: null,
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
          api: "anthropic-messages",
          provider: "anthropic",
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
      },
    });
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
    await expect(postProcess).toHaveValue("utility");
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
    // A path/search input is not a dictation target.
    await page.getByLabel("Use an existing Core ML Parakeet model folder").focus();
    await expect(page.locator('[data-slot="dictation-indicator"]')).toHaveCount(0);
    await expect(page.getByLabel("Use an existing Core ML Parakeet model folder")).toHaveValue("");
    await configure({ ready: true, hold: true });
    await page.getByRole("button", { name: "Back to chat" }).click();
    await page.locator(`[data-navigation-item][data-session-id="${sessionId}"]`).click();
    const composer = page.getByRole("combobox", { name: "Message", exact: true });
    await composer.click();
    await composer.pressSequentially("Typed first. ");
    await expect(composer).toHaveValue("Typed first. ");
    await expect(composer).toBeFocused();
    await configure({ ready: true, text: "Spoken next." });
    await expect(composer).toHaveValue("Typed first. Spoken next.");
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
    const composerControl = composer.locator("..").getByRole("button", { name: "Mute dictation" });
    const textInset = await composer.evaluate((element) =>
      parseFloat(getComputedStyle(element).paddingLeft),
    );
    expect(
      (await composerControl.boundingBox())!.x - (await composer.boundingBox())!.x,
    ).toBeCloseTo(textInset, 0);
    // Check Chromium's actual textarea rendering, not a mirror element: only the first
    // line is inset for the leading meter, including both soft wraps and explicit newlines.
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
      expect(positions.indent).toBeGreaterThan(24);
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
    await page.getByRole("button", { name: "Open settings", exact: true }).click();
    await configure({ ready: true, text: "Discard this tail" });
    await page.getByRole("button", { name: "Back to chat" }).click();
    await page.locator(`[data-navigation-item][data-session-id="${sessionId}"]`).click();
    await expect(composer).toHaveValue("Typed first. Spoken next.");
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
    const errorControl = page.getByRole("button", { name: "Mute dictation", exact: true });
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
    await page.getByRole("button", { name: "Unmute dictation", exact: true }).click();
    await expect(page.locator('[data-slot="dictation-indicator"]')).toHaveText("Listening");
    await composer.fill("Typed first. Spoken next.");
    // Select transcript prose and exercise the real native context-menu path.
    await configure({ ready: true, hold: true });
    if (localRoot) {
      await page.getByRole("button", { name: "Open settings", exact: true }).click();
      await page.getByRole("button", { name: /Voice & Dictation/ }).click();
      await page.getByLabel("Text processing", { exact: true }).selectOption("local");
      await page.getByRole("button", { name: "Back to chat" }).click();
      await page.locator(`[data-navigation-item][data-session-id="${sessionId}"]`).click();
    }
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
    const annotationText = localRoot
      ? "Typed: Is this a question that I should be asking?"
      : "Please change this implementation carefully.";
    if (localRoot) {
      await annotation.pressSequentially("Typed:");
      await expect(annotation).toHaveValue("Typed:");
      await expect(annotation).toBeFocused();
      await configure({ ready: true, text: "Is this a question that I should?" });
      await expect(annotation).toHaveValue("Typed: Is this a question that I should");
      await configure({ ready: true, text: "Is this a question that I should? Be asking?" });
      await expect(annotation).toHaveValue("Typed: Is this a question that I should be asking");
      await expect(page.locator('[data-slot="provisional-text"]')).toHaveText("I should be asking");
      await expect(annotation).toBeFocused();
    } else {
      await configure({ ready: true, text: "Please change", finalText: annotationText });
      await expect(annotation).toHaveValue("Please change");
    }
    await annotation.press("Enter");
    await expect(page.getByRole("dialog", { name: "Add annotation" })).toHaveCount(0);
    await configure({ ready: true, hold: true });
    await page.getByRole("button", { name: "View annotation 1", exact: true }).click();
    await expect(page.getByText(annotationText, { exact: true })).toBeVisible();
    const details = page.getByRole("dialog", { name: "Annotation details" });
    await details.getByRole("button", { name: "Edit annotation" }).click();
    const edit = page.getByLabel("Edit annotation comment");
    await expect(edit).toBeFocused();
    await expect(page.getByRole("button", { name: "Mute dictation" })).toBeVisible();
    await edit.press("Escape");
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
    application = await launch();
    const restarted = await application.firstWindow();
    // Settings and enablement are restored; temporary mute is not.
    await restarted.getByRole("button", { name: /Voice & Dictation/ }).click();
    const restartedMode = restarted.getByRole("switch", { name: "Dictation mode" });
    await expect(restartedMode).toBeChecked();
    await expect(restarted.getByLabel("Text processing", { exact: true })).toHaveValue("raw");
    await restarted.getByLabel("Try dictation").focus();
    await expect(restarted.getByRole("button", { name: "Mute dictation" })).toHaveAttribute(
      "aria-pressed",
      "false",
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
  } finally {
    await application.close();
    await rm(root, { recursive: true, force: true });
  }
});
