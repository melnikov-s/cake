import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "../../scripts/queued-electron.mjs";
import { expect, test } from "@playwright/test";
import { cakeWorkspaceSessionDirectory } from "../../src/services/pi/runtime/session-discovery";
import { windowState } from "../fixtures/window-state";
import type { ComposerInputElement } from "../../src/renderer/lib/composer-input-element";

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
      { type: "session_info", id: "source-name", parentId: null, timestamp, name: "Picker source" },
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

  const moveDestination = "move-draft-destination";
  await writeFile(
    join(sessionDirectory, `1970-01-01T00-00-00-000Z_${moveDestination}.jsonl`),
    [
      { type: "session", version: 3, id: moveDestination, timestamp, cwd: project },
      {
        type: "session_info",
        id: "destination-name",
        parentId: null,
        timestamp,
        name: "Draft destination",
      },
      {
        type: "message",
        id: "destination-prompt",
        parentId: null,
        timestamp,
        message: {
          role: "user",
          content: [{ type: "text", text: "Draft destination fixture" }],
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
    // This fixture owns reference behavior, not startup navigation restoration.
    const openSession = async (title: string) => {
      await page.getByRole("button", { name: "Search sessions", exact: true }).click();
      const search = page.getByRole("dialog", { name: "Search sessions" });
      await search.getByRole("combobox").fill(title);
      await search.getByRole("option", { name: new RegExp(title) }).click();
    };
    await openSession("Picker source");
    await expect(
      page.locator(".transcript").getByText("Model picker fixture ready", { exact: true }),
    ).toBeVisible();
    const composer = page.getByRole("combobox", { name: "Message", exact: true });
    const composerValue = () => composer.evaluate((element: ComposerInputElement) => element.value);
    await expect(composer).toBeVisible({ timeout: 20_000 });
    await expect(composer).toBeFocused();
    // Shared slash completion must still restore a writable, correctly placed caret.
    await composer.fill("/mod");
    await expect(page.getByRole("listbox", { name: "Slash commands" })).toBeVisible();
    await composer.press("Tab");
    await expect(composer).toHaveValue("/model ");
    await expect(composer).toBeFocused();
    await page.keyboard.type("fixture");
    await expect(composer).toHaveValue("/model fixture");
    await composer.fill("");
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
    const sessions = page.getByRole("dialog", { name: "Session reference" });
    let projectExpanded = false;
    // The first insertion swaps the textarea for the atomic-token editor. Type
    // immediately, before reopening/editing a chip can accidentally repair focus.
    for (const { draft, start, end } of [
      { draft: "", start: 0, end: 0 },
      { draft: "Before", start: 6, end: 6 },
      { draft: "Before after", start: 7, end: 7 },
      { draft: "Before replace after", start: 7, end: 14 },
    ]) {
      await composer.fill(draft);
      await composer.evaluate(
        (element: ComposerInputElement, range) => {
          element.focus();
          element.setSelectionRange(range.start, range.end);
          element.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
        },
        { start, end },
      );
      await expect(sessions).toBeVisible();
      if (!projectExpanded) {
        // No highlighted destination: projects start collapsed; the hand expansion is kept on reopen.
        await sessions.getByRole("button", { name: "Expand project", exact: true }).click();
        projectExpanded = true;
      }
      await sessions.locator(`[data-session-id="${moveDestination}"]`).getByRole("button").click();
      await expect(sessions).toBeHidden();
      await expect(composer).toBeFocused();
      await page.keyboard.type("typed");
      const token = `[Session](cake://session/${moveDestination})`;
      await expect
        .poll(composerValue)
        .toBe(draft.slice(0, start) + token + " typed" + draft.slice(end).replace(/^ /, ""));
      await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
    }
    await composer.fill("Pending first prompt retained");
    await composer.click({ button: "right" });
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
    await sessions.locator(`[data-session-id="${moveDestination}"]`).getByRole("button").click();
    await expect(sessions).toBeHidden();
    await expect(composer).toBeFocused();
    const linked = await composerValue();
    const sessionChip = composer.getByRole("button", {
      name: "Edit session reference: Draft destination",
      exact: true,
    });
    await expect(sessionChip).toHaveText("Draft destination");
    await expect(sessionChip).toHaveAttribute("aria-haspopup", "dialog");
    await expect(sessionChip.locator("svg")).toHaveCount(2);
    await sessionChip.click();
    await expect(sessions).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(sessions).toBeHidden();
    await expect.poll(composerValue).toBe(linked);
    await sessionChip.focus();
    await sessionChip.press("Enter");
    await expect(sessions).toBeVisible();
    await sessions.locator(`[data-session-id="${sessionId}"]`).getByRole("button").click();
    await expect(
      composer.getByRole("button", { name: "Edit session reference: Picker source", exact: true }),
    ).toBeVisible();
    await expect.poll(composerValue).toBe(linked.replace(moveDestination, sessionId));
    await expect(composer).toBeFocused();
    // Space follows the same native button activation convention as Enter.
    const changedChip = composer.getByRole("button", {
      name: "Edit session reference: Picker source",
      exact: true,
    });
    await changedChip.focus();
    await changedChip.press("Space");
    await expect(sessions).toBeVisible();
    await sessions.locator(`[data-session-id="${moveDestination}"]`).getByRole("button").click();
    await expect(composer).toBeFocused();
    const prefix = "Pending first prompt retained".slice(0, selection.start);
    const suffix = "Pending first prompt retained".slice(selection.end);
    const link = linked.slice(prefix.length, linked.length - suffix.length);
    expect(link).toMatch(/^\[Session\]\(cake:\/\/session\/[^\s)]+\) ?$/);
    expect(linked).toBe(prefix + link + suffix);
    await composer.pressSequentially(" session retained");
    await expect.poll(composerValue).toBe(prefix + link + " session retained" + suffix);
    await expect(
      page.locator(".transcript").getByText("Model picker fixture ready", { exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
    const draftWithLink = await composerValue();
    await composer.click({ button: "right" });
    await expect(sessions).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(sessions).toBeHidden();
    await expect(composer).toBeFocused();
    await expect.poll(composerValue).toBe(draftWithLink);
    await composer.click({ button: "right" });
    await expect(sessions).toBeVisible();
    await configuration.click();
    await expect(sessions).toBeHidden();
    await expect(composer).not.toBeFocused();
    await page.keyboard.press("Escape");
    await expect.poll(composerValue).toBe(draftWithLink);
    await composer.fill("Pending first prompt retained");
    await application.evaluate(({ Menu }) => Reflect.deleteProperty(Menu, "referenceAction"));

    // The editor remains token-capable after clearing the earlier references.
    // Capture the intended selection before the picker moves DOM focus away.
    await composer.evaluate((element: ComposerInputElement) => {
      element.focus();
      element.setSelectionRange(8, 13);
      element.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    });
    const reference = page.getByRole("dialog", { name: "Model reference" });
    await expect(reference).toBeVisible();
    const insertionPoint = 8;
    const selectionEnd = 13;
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
      `${original.slice(0, insertionPoint)}${token} inserted${original.slice(selectionEnd)}`,
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
    await openSession("Picker source");
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
    await openSession("Picker source");
    await expect(sentChips).toHaveCount(2);

    // Move the whole composer (not just its selection) through native RPC and
    // the shared destination popover. This must navigate without submitting.
    const movingInput = page.getByRole("combobox", { name: "Message", exact: true });
    // Start this independent routing phase with an explicit draft, not a restored one.
    await movingInput.fill("");
    await movingInput.pressSequentially("A draft to move, not send");
    await application.evaluate(({ Menu }) =>
      Reflect.set(Menu, "referenceAction", "Move draft to session…"),
    );
    await movingInput.click({ button: "right" });
    const destinations = page.getByRole("dialog", { name: "Move draft to session" });
    await expect(destinations).toBeVisible();
    await destinations.getByRole("button", { name: "Expand project", exact: true }).click();
    await expect(destinations.locator(`[data-session-id="${sessionId}"]`)).toHaveCount(0);
    await destinations
      .locator(`[data-session-id="${moveDestination}"]`)
      .getByRole("button")
      .click();
    await expect(destinations).toBeHidden();
    await expect(page.getByText("Draft moved", { exact: true })).toBeVisible();
    await expect(movingInput).toHaveValue("A draft to move, not send");
    await expect(movingInput).toBeFocused();
    await movingInput.pressSequentially(" and review");
    await expect(movingInput).toHaveValue("A draft to move, not send and review");
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
    await expect(
      page.locator(".transcript").getByText("Draft destination fixture", { exact: true }),
    ).toBeVisible();
    // Later edits must not be erased by Undo.
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await expect(
      page.getByText("Cannot undo because a draft changed. Both drafts were left untouched."),
    ).toBeVisible();
    await page.reload();
    await openSession("Draft destination");
    await expect(movingInput).toHaveValue("A draft to move, not send and review");
    await expect(
      page
        .locator(".transcript")
        .getByText("A draft to move, not send and review", { exact: true }),
    ).toHaveCount(0);
  } finally {
    await application.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
