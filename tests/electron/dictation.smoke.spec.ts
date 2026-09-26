import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  const control = join(model, "control.json");
  const configure = (value: {
    ready: boolean;
    hold?: boolean;
    text?: string;
    finalText?: string;
  }) => writeFile(control, JSON.stringify(value));
  await configure({ ready: false, hold: true });
  await writeFile(join(dictation, "settings.json"), JSON.stringify({ modelPath: model }));
  const helper = join(root, "cake-dictation");
  // Fake only the external native process. Real Service, RPC, Store, audio worklet and React input.
  await writeFile(
    helper,
    `#!${process.execPath}
const fs = require('node:fs'); const path = require('node:path'); const readline = require('node:readline');
const directory = process.argv.at(-1); const control = path.join(directory, 'control.json');
const config = () => JSON.parse(fs.readFileSync(control, 'utf8'));
const wait = (predicate) => new Promise(resolve => { const check = () => { try { if (predicate(config())) { watcher.close(); resolve(); } } catch {} }; const watcher = fs.watch(directory, check); check(); });
const reply = value => process.stdout.write(JSON.stringify(value) + '\\n');
(async () => {
  await wait(value => value.ready); reply({ ready: true });
  let count = 0;
  for await (const line of readline.createInterface({ input: process.stdin })) {
    const request = JSON.parse(line); fs.writeFileSync(path.join(directory, 'request.json'), JSON.stringify({ count: ++count, final: request.final, id: request.utteranceId }));
    await wait(value => !value.hold); const value = config(); reply({ text: request.final ? (value.finalText ?? value.text ?? '') : (value.text ?? '') });
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
  const application = await electron.launch({
    args: [repositoryRoot, "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
    cwd: repositoryRoot,
    env: {
      ...process.env,
      CAKE_ELECTRON_SMOKE: "1",
      CAKE_SMOKE_DICTATION_HELPER: helper,
      CAKE_ELECTRON_USER_DATA: userData,
      CAKE_HOME: cakeHome,
    },
  });
  try {
    const page = await application.firstWindow();
    await expect(
      page.getByText("Inspect this implementation before changing it.", { exact: true }),
    ).toBeVisible({ timeout: 20_000 });
    await page.getByRole("button", { name: "Open settings", exact: true }).click();
    await page.getByRole("button", { name: /Dictation Local speech to text/ }).click();
    await page.getByRole("switch", { name: "Dictation mode" }).click();
    const sample = page.getByLabel("Try dictation");
    await sample.focus();
    await expect(page.locator('[data-slot="dictation-indicator"]')).toContainText("Preparing");
    await configure({ ready: true, text: "Dictation is ready" });
    await expect(page.locator('[data-slot="dictation-indicator"]')).toHaveText("Listening", {
      timeout: 15_000,
    });
    await expect(sample).toHaveValue("Dictation is ready");
    // A path/search input is not a dictation target.
    await page.getByLabel("Use an existing Core ML Parakeet model folder").focus();
    await expect(page.locator('[data-slot="dictation-indicator"]')).toHaveCount(0);
    await expect(page.getByLabel("Use an existing Core ML Parakeet model folder")).toHaveValue("");
    await configure({ ready: true, hold: true });
    await page.getByRole("button", { name: "Back to chat" }).click();
    await page.locator(`[data-session-id="${sessionId}"]`).click();
    const composer = page.getByRole("combobox", { name: "Message", exact: true });
    await composer.click();
    await composer.pressSequentially("Typed first. ");
    await expect(composer).toHaveValue("Typed first. ");
    await expect(composer).toBeFocused();
    await configure({ ready: true, text: "Spoken next." });
    await expect(composer).toHaveValue("Typed first. Spoken next.");
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
    // Hold a result, leave the field, then complete it. It must not change the old draft.
    const before = JSON.parse(await readFile(join(model, "request.json"), "utf8")).count;
    await configure({ ready: true, hold: true, text: "Discard this tail" });
    await expect
      .poll(async () => JSON.parse(await readFile(join(model, "request.json"), "utf8")).count)
      .toBeGreaterThan(before);
    await page.getByRole("button", { name: "Open settings", exact: true }).click();
    await configure({ ready: true, text: "Discard this tail" });
    await page.getByRole("button", { name: "Back to chat" }).click();
    await page.locator(`[data-session-id="${sessionId}"]`).click();
    await expect(composer).toHaveValue("Typed first. Spoken next.");
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
    await configure({
      ready: true,
      text: "Please change",
      finalText: "Please change this implementation carefully.",
    });
    await expect(annotation).toHaveValue("Please change");
    await annotation.press("Enter");
    await expect(page.getByRole("dialog", { name: "Add annotation" })).toHaveCount(0);
    await configure({ ready: true, hold: true });
    await page.getByRole("button", { name: "View annotation 1", exact: true }).click();
    await expect(
      page.getByText("Please change this implementation carefully.", { exact: true }),
    ).toBeVisible();
  } finally {
    await application.close();
    await rm(root, { recursive: true, force: true });
  }
});
