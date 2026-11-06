import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "../../scripts/queued-electron.mjs";
import { expect, test } from "@playwright/test";
import { cakeWorkspaceSessionDirectory } from "../../src/services/pi/runtime/session-discovery";
import { windowState } from "../fixtures/window-state";

const repositoryRoot = resolve(import.meta.dirname, "../..");

test("shared model and session reference pickers preserve composer input and focus", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "cake-model-picker-smoke-"));
  const userData = join(temporaryRoot, "user-data");
  const project = join(temporaryRoot, "project");
  const cakeHome = join(temporaryRoot, "cake-home");
  const sessionId = "model-picker-session";
  const timestamp = new Date(0).toISOString();
  const sessionDirectory = cakeWorkspaceSessionDirectory(project, join(cakeHome, "pi", "sessions"));
  await Promise.all([
    mkdir(userData, { recursive: true }),
    mkdir(project, { recursive: true }),
    mkdir(join(cakeHome, "state"), { recursive: true }),
    mkdir(sessionDirectory, { recursive: true }),
  ]);
  await writeFile(join(userData, "window-state.json"), windowState({ project, sessionId }));
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
      modelPresets: [
        {
          id: "00000000-0000-4000-8000-000000000001",
          name: "Fixture preset",
          provider: "picker-fixture-provider",
          modelId: "fixture-model",
          thinkingLevel: "off",
          fastMode: false,
        },
      ],
    }),
  );
  const model = {
    id: "fixture-model",
    name: "Fixture model",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32000,
    maxTokens: 1024,
  };
  await writeFile(
    join(cakeHome, "pi", "models.json"),
    JSON.stringify({
      providers: {
        "picker-fixture-provider": {
          baseUrl: "http://127.0.0.1:1/v1",
          apiKey: "fixture-key",
          api: "openai-completions",
          models: [model],
        },
        "picker-locked-provider": {
          baseUrl: "http://127.0.0.1:1/v1",
          api: "openai-completions",
          models: [{ ...model, name: "Locked fixture model" }],
        },
      },
    }),
  );

  // Restore a loaded conversation rather than racing the empty project's
  // staged-session initialization and its deferred composer-focus request.
  await writeFile(
    join(sessionDirectory, `1970-01-01T00-00-00-000Z_${sessionId}.jsonl`),
    [
      { type: "session", version: 3, id: sessionId, timestamp, cwd: project },
      {
        type: "model_change",
        id: "fixture-model",
        parentId: null,
        timestamp,
        provider: "picker-fixture-provider",
        modelId: "fixture-model",
      },
      {
        type: "message",
        id: "fixture-prompt",
        parentId: "fixture-model",
        timestamp,
        message: {
          role: "user",
          content: [{ type: "text", text: "Model picker fixture ready" }],
          timestamp: 0,
        },
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n") + "\n",
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
    await expect(
      page.locator(".transcript").getByText("Model picker fixture ready", { exact: true }),
    ).toBeVisible();
    const composer = page.getByRole("combobox", { name: "Message", exact: true });
    await expect(composer).toBeVisible({ timeout: 20_000 });
    await expect(composer).toBeFocused();
    // Verify a real draft survives every keyboard/mouse model-picker interaction.
    await composer.pressSequentially("Pending first prompt");
    await expect(composer).toHaveValue("Pending first prompt");
    await expect(composer).toBeFocused();
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
    const configuration = page.getByRole("button", { name: "Model configuration" });
    await configuration.focus();
    await configuration.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Model configuration" });
    await expect(dialog).toBeVisible();
    const search = page.getByLabel("Search presets and models");
    const change = dialog.getByRole("button", { name: /Change model/ });
    await expect(search.or(change)).toBeVisible();
    if (await change.isVisible()) await change.click();
    await expect(search).toBeFocused();
    await search.pressSequentially("Fixture");
    await expect(search).toHaveValue("Fixture");
    await expect(search).toBeFocused();
    await expect(dialog.getByRole("button", { name: /Fixture preset/ })).toBeVisible();
    await expect(
      dialog.getByRole("button", { name: "Fixture model fixture-model", exact: true }),
    ).toBeVisible();
    await expect(dialog.getByRole("button", { name: /Locked fixture model/ })).toHaveCount(0);
    await search.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(configuration).toBeFocused();

    // A mouse reopen uses the current catalog; selecting and applying a
    // model does not cause another load or lose the deferred local choice.
    await configuration.click();
    if (await change.isVisible()) await change.click();
    await search.fill("Fixture model");
    await dialog.getByRole("button", { name: "Fixture model fixture-model", exact: true }).click();
    await dialog.getByRole("button", { name: "High", exact: true }).click();
    await dialog.getByRole("button", { name: "Apply", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(configuration).toContainText("Fixture model");
    await expect(configuration).toContainText("High");

    await configuration.focus();
    await configuration.press("Space");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: "High", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await change.click();
    await search.pressSequentially("Fixture preset");
    await expect(search).toHaveValue("Fixture preset");
    await expect(search).toBeFocused();
    await dialog.getByRole("button", { name: /Fixture preset/ }).click();
    await expect(dialog).toBeHidden();
    await expect(configuration).toContainText("Fixture preset");

    await composer.click();
    await expect(composer).toBeFocused();
    await expect(composer).toHaveValue("Pending first prompt");
    await composer.pressSequentially(" retained");
    await expect(composer).toHaveValue("Pending first prompt retained");
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();

    // Exercise the native menu contract without showing an OS popup in a hidden test.
    // The renderer still opens it through a real right-click and RPC round trip.
    await application.evaluate(({ Menu }) => {
      const build = Menu.buildFromTemplate.bind(Menu);
      Menu.buildFromTemplate = (template) => {
        const menu = build(template);
        const labels = menu.items.map((item) => item.label);
        Reflect.set(Menu, "referenceLabels", labels);
        const insert = menu.items.find(
          (item) =>
            item.label === (Reflect.get(Menu, "referenceAction") ?? "Insert model reference"),
        );
        if (insert)
          menu.popup = (options) => {
            insert.click();
            options?.callback?.();
          };
        return menu;
      };
    });
    await application.evaluate(({ Menu }) =>
      Reflect.set(Menu, "referenceAction", "Insert session reference"),
    );
    await composer.click({ button: "right" });
    const sessions = page.getByRole("dialog", { name: "Session reference" });
    await expect(sessions).toBeVisible();
    const labels = await application.evaluate(
      ({ Menu }) => Reflect.get(Menu, "referenceLabels") as string[],
    );
    const modelEntry = labels.indexOf("Insert model reference");
    expect(modelEntry).toBeGreaterThan(-1);
    expect(labels[modelEntry + 1]).toBe("Insert session reference");
    const selection = await composer.evaluate((element: HTMLTextAreaElement) => ({
      start: element.selectionStart,
      end: element.selectionEnd,
    }));
    await sessions.getByRole("button", { name: "Collapse project", exact: true }).click();
    await expect(sessions.locator(`[data-session-id="${sessionId}"]`)).toHaveCount(0);
    await sessions.getByRole("button", { name: "Expand project", exact: true }).click();
    await expect(sessions.locator(`[data-session-id="${sessionId}"]`)).toBeVisible();
    // Choose a different chat through the shared menu; this must insert, never navigate.
    await sessions.locator('[data-slot="destination-cake-chat"]').first().click();
    await expect(sessions).toBeHidden();
    await expect(composer).toBeFocused();
    const linked = await composer.inputValue();
    const prefix = "Pending first prompt retained".slice(0, selection.start);
    const suffix = "Pending first prompt retained".slice(selection.end);
    const link = linked.slice(prefix.length, linked.length - suffix.length);
    expect(link).toMatch(/^\[Session\]\(cake:\/\/session\/[^\s)]+\)$/);
    expect(linked).toBe(prefix + link + suffix);
    await composer.pressSequentially(" session retained");
    await expect(composer).toHaveValue(prefix + link + " session retained" + suffix);
    await expect(
      page.locator(".transcript").getByText("Model picker fixture ready", { exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
    const draftWithLink = await composer.inputValue();
    await composer.click({ button: "right" });
    await expect(sessions).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(sessions).toBeHidden();
    await expect(composer).toBeFocused();
    await expect(composer).toHaveValue(draftWithLink);
    await composer.click({ button: "right" });
    await expect(sessions).toBeVisible();
    await configuration.click();
    await expect(sessions).toBeHidden();
    await expect(composer).not.toBeFocused();
    await page.keyboard.press("Escape");
    await expect(composer).toHaveValue(draftWithLink);
    await composer.fill("Pending first prompt retained");
    await application.evaluate(({ Menu }) => Reflect.deleteProperty(Menu, "referenceAction"));

    await composer.evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(8, 13));
    await composer.click({ button: "right", position: { x: 80, y: 20 } });
    const reference = page.getByRole("dialog", { name: "Model reference" });
    await expect(reference).toBeVisible();
    const insertionPoint = await composer.evaluate(
      (element: HTMLTextAreaElement) => element.selectionStart,
    );
    await reference.getByRole("button", { name: /Fixture preset/ }).click();
    const richInput = page.getByRole("combobox", { name: "Message", exact: true });
    const chip = richInput.getByRole("button", { name: /Edit model reference/ });
    await expect(chip).toContainText("Fixture preset");
    await expect(richInput).toBeFocused();
    await expect
      .poll(() => richInput.evaluate((element) => Reflect.get(element, "selectionStart")))
      .toBeGreaterThan(30);
    await richInput.pressSequentially(" inserted");
    await expect(richInput).toContainText(" inserted");
    await expect(configuration).toContainText("Fixture preset");
    await chip.focus();
    await chip.press("Enter");
    await expect(reference).toBeVisible();
    await reference.getByRole("button", { name: "High", exact: true }).click();
    await expect(chip).toContainText("high");
    // This edits only the reference, not the active configuration.
    await expect(configuration).not.toContainText("High");
    const canonical = await richInput.evaluate(
      (element) => Reflect.get(element, "value") as string,
    );
    expect(canonical).toContain('"thinkingLevel":"high"');
    expect(canonical).toContain('"fastMode":false');
    expect(canonical).toContain('"preset":{"id":"00000000-0000-4000-8000-000000000001"}');
    const token = canonical.match(/<cake-model>.*?<\/cake-model>/)![0];
    const original = "Pending first prompt retained";
    expect(canonical).toBe(
      `${original.slice(0, insertionPoint)}${token} inserted${original.slice(insertionPoint)}`,
    );

    await richInput.click();
    await richInput.press("End");
    await richInput.click({ button: "right" });
    await expect(reference).toBeVisible();
    await reference
      .getByRole("button", { name: "Fixture model fixture-model", exact: true })
      .click();
    await reference.getByRole("button", { name: "High", exact: true }).click();
    await reference.getByRole("button", { name: "Apply", exact: true }).click();
    await expect(richInput.getByRole("button", { name: /Edit model reference/ })).toHaveCount(2);
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Send", exact: true }).click();
    const sentChips = page.locator('[data-slot="message-content"] [data-slot="model-reference"]');
    await expect(sentChips).toHaveCount(2);
    await expect(sentChips.first()).not.toHaveRole("button");
    await page.reload();
    await expect(sentChips).toHaveCount(2);
    const sentMessage = page
      .locator("article")
      .filter({ has: page.locator('[data-slot="model-reference"]') })
      .last();
    await sentMessage.hover();
    const markdownToggle = sentMessage.getByRole("button", {
      name: "Render as Markdown",
      exact: true,
    });
    await expect(markdownToggle).toBeVisible();
    await markdownToggle.click();
    await expect(sentChips).toHaveCount(2);
    await page.reload();
    await expect(sentChips).toHaveCount(2);
  } finally {
    await application.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
