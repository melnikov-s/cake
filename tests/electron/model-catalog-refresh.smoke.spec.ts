import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { _electron as electron } from "../../scripts/queued-electron.mjs";
import { cakeWorkspaceSessionDirectory } from "../../src/services/pi/runtime/session-discovery";
import { windowState } from "../fixtures/window-state";

test("Provider Refresh makes a fetched model and its preset selectable in an open Project Session", async ({}, info) => {
  const repo = resolve(import.meta.dirname, "../..");
  const root = await mkdtemp(join(tmpdir(), "cake-model-refresh-smoke-"));
  const cakeHome = join(root, "cake");
  const agentDir = join(cakeHome, "pi");
  const userData = join(root, "user-data");
  const project = join(root, "project");
  const provider = "openai";
  const model = {
    id: "cake-refreshed-fixture",
    name: "Refreshed fixture model",
    provider,
    api: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32_000,
    maxTokens: 1_024,
  };
  const sessionId = "refresh-model-session";
  const timestamp = new Date(0).toISOString();
  const sessions = cakeWorkspaceSessionDirectory(project, join(agentDir, "sessions"));
  await Promise.all(
    [project, userData, sessions, join(cakeHome, "state")].map((path) =>
      mkdir(path, { recursive: true }),
    ),
  );
  await writeFile(join(userData, "window-state.json"), windowState({ project, sessionId }));
  await writeFile(
    join(agentDir, "auth.json"),
    JSON.stringify({
      [provider]: { type: "api_key", key: "fixture-key" },
    }),
  );
  await writeFile(
    join(cakeHome, "state", "application.json"),
    JSON.stringify({
      schemaVersion: 1,
      projects: [{ path: project, name: "project", addedAt: timestamp, lastOpenedAt: timestamp }],
      modelPresets: [
        {
          id: "00000000-0000-4000-8000-000000000001",
          name: "Refreshed preset",
          provider,
          modelId: model.id,
          thinkingLevel: "off",
          fastMode: false,
        },
      ],
    }),
  );
  await writeFile(
    join(sessions, `${timestamp.replaceAll(":", "-").replace(".", "-")}_${sessionId}.jsonl`),
    [
      { type: "session", version: 3, id: sessionId, timestamp, cwd: project },
      {
        type: "session_info",
        id: "title",
        parentId: null,
        timestamp,
        name: "Refresh fixture chat",
      },
      {
        type: "model_change",
        id: "old-model",
        parentId: null,
        timestamp,
        provider,
        modelId: "gpt-4o",
      },
      {
        type: "message",
        id: "prompt",
        parentId: "old-model",
        timestamp,
        message: {
          role: "user",
          content: [{ type: "text", text: "Open before refresh" }],
          timestamp: 0,
        },
      },
    ]
      .map((line) => JSON.stringify(line))
      .join("\n") + "\n",
  );
  try {
    const app = await electron.launch({
      args: [repo],
      cwd: repo,
      env: {
        ...process.env,
        CAKE_ELECTRON_SMOKE: "1",
        CAKE_ELECTRON_USER_DATA: userData,
        CAKE_HOME: cakeHome,
        PI_CODING_AGENT_DIR: agentDir,
        PI_CODING_AGENT_SESSION_DIR: "",
        OPENROUTER_API_KEY: "",
      },
    });
    try {
      const page = await app.firstWindow();
      await page.getByRole("button", { name: "Search sessions", exact: true }).click();
      const sessionSearch = page.getByRole("dialog", { name: "Search sessions" });
      await sessionSearch.getByRole("combobox").fill("Refresh fixture chat");
      await sessionSearch.getByRole("option", { name: /Refresh fixture chat/ }).click();
      await expect(page.locator(".transcript").getByText("Open before refresh")).toBeVisible();

      const configuration = page.getByRole("button", { name: "Model configuration", exact: true });
      const dialog = page.getByRole("dialog", { name: "Model configuration" });
      const search = dialog.getByLabel("Search presets and models");
      const change = dialog.getByRole("button", { name: /Change model/ });
      const openPicker = async () => {
        await configuration.click();
        await expect(search.or(change)).toBeVisible();
        if (await change.isVisible()) await change.click();
      };
      const fetchedModel = dialog.getByRole("button", {
        name: `${model.name} ${model.id}`,
        exact: true,
      });
      await openPicker();
      await search.fill(model.id);
      await expect(fetchedModel).toHaveCount(0);
      await search.press("Escape");
      await expect(dialog).toBeHidden();

      // This is our isolated child process, not the user's running app. Replace
      // only the Pi catalog endpoint; actual SDK refresh, IPC and UI run unchanged.
      await app.evaluate((_electron, remote) => {
        globalThis.fetch = async (input) => {
          const url = new URL(input instanceof Request ? input.url : input);
          if (url.origin !== "https://pi.dev" || !url.pathname.startsWith("/api/models/providers/"))
            throw new Error("Unexpected network request in model catalog fixture");
          return url.pathname.endsWith("/openai")
            ? Response.json([remote], {
                headers: { "last-modified": "Wed, 01 Jan 2098 00:00:00 GMT" },
              })
            : new Response(null, { status: 404 });
        };
      }, model);
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      await page.getByRole("button", { name: /^Providers\b/ }).click();
      const refresh = page.getByRole("button", { name: "Refresh models", exact: true });
      await refresh.click();
      await expect(refresh).toBeEnabled();
      await expect(page.getByText("Could not load models")).toHaveCount(0);
      await page.getByRole("button", { name: "Back to chat", exact: true }).click();

      await openPicker();
      await search.fill(model.id);
      await expect(fetchedModel).toBeVisible();
      await page.screenshot({ path: info.outputPath("refreshed-model-picker.png") });
      await fetchedModel.click();
      await dialog.getByRole("button", { name: "Apply", exact: true }).click();
      await expect(configuration).toContainText(model.name);
      // Switch away before selecting the preset so this is a second model change.
      await openPicker();
      await search.fill("gpt-4o");
      await dialog.getByRole("button", { name: / gpt-4o$/ }).click();
      await dialog.getByRole("button", { name: "Apply", exact: true }).click();
      await expect(configuration).not.toContainText(model.name);
      await openPicker();
      await search.fill("Refreshed preset");
      await dialog.getByRole("button", { name: /Refreshed preset/ }).click();
      await expect(configuration).toContainText("Refreshed preset");
      await expect(page.locator(".transcript").getByText("Open before refresh")).toBeVisible();
      await page.screenshot({ path: info.outputPath("refreshed-preset-applied.png") });
    } finally {
      await app.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
