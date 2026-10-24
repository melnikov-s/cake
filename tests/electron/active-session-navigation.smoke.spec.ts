import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { cakeWorkspaceSessionDirectory } from "../../src/services/pi/runtime/session-discovery";
import { installLocalModelHttpGuard } from "./main-harness";
import { windowState } from "../fixtures/window-state";

const repositoryRoot = resolve(import.meta.dirname, "../..");
function chunk(content: string, finishReason: string | null = null) {
  return `data: ${JSON.stringify({
    id: "active-navigation-fixture",
    object: "chat.completion.chunk",
    created: 0,
    model: "fixture-model",
    choices: [{ index: 0, delta: { content }, finish_reason: finishReason }],
  })}\n\n`;
}

for (const [title, activityOrdering] of [
  ["session shortcuts respect Project focus and restore cross-project navigation on exit", false],
  [
    "activity completion reorders rows while preserving the selected conversation and composer",
    true,
  ],
] as const) {
  test(title, () => verifyNavigation(activityOrdering));
}

async function verifyNavigation(activityOrdering: boolean) {
  test.setTimeout(60_000);
  const temporaryRoot = await mkdtemp(join(tmpdir(), "cake-active-navigation-"));
  const userData = join(temporaryRoot, "user-data");
  const cakeHome = join(temporaryRoot, "cake-home");
  const alpha = join(temporaryRoot, "alpha");
  const beta = join(temporaryRoot, "beta");
  const streams: ServerResponse[] = [];
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(chunk("Working on this assignment."));
      streams.push(response);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const timestamp = new Date(0).toISOString();
  await Promise.all([
    mkdir(userData, { recursive: true }),
    mkdir(alpha, { recursive: true }),
    mkdir(beta, { recursive: true }),
    mkdir(join(cakeHome, "pi"), { recursive: true }),
    mkdir(join(cakeHome, "state"), { recursive: true }),
  ]);
  await writeFile(
    join(cakeHome, "pi", "models.json"),
    JSON.stringify({
      providers: {
        "navigation-provider": {
          name: "Navigation provider",
          baseUrl: `${origin}/v1`,
          apiKey: "fixture",
          api: "openai-completions",
          models: [
            {
              id: "fixture-model",
              name: "Navigation fixture",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 128000,
              maxTokens: 1024,
            },
          ],
        },
      },
    }),
  );
  await writeFile(
    join(cakeHome, "state", "application.json"),
    JSON.stringify({
      schemaVersion: 1,
      projects: [alpha, beta].map((path) => ({
        path,
        name: path === alpha ? "alpha" : "beta",
        addedAt: timestamp,
        lastOpenedAt: timestamp,
      })),
      trustedProjectPaths: [alpha, beta],
    }),
  );
  await writeFile(
    join(userData, "window-state.json"),
    windowState({ project: alpha, sessionId: "alpha-worker", projects: [alpha, beta] }),
  );
  for (const [id, project] of [
    ["alpha-worker", alpha],
    ["alpha-idle", alpha],
    ["beta-worker", beta],
    ["idle-session", beta],
  ]) {
    const directory = cakeWorkspaceSessionDirectory(project!, join(cakeHome, "pi", "sessions"));
    await mkdir(directory, { recursive: true });
    const file = join(directory, `1970-01-01T00-00-00-000Z_${id}.jsonl`);
    await writeFile(
      file,
      [
        { type: "session", version: 3, id, timestamp, cwd: project },
        {
          type: "model_change",
          id: "model",
          parentId: null,
          timestamp,
          provider: "navigation-provider",
          modelId: "fixture-model",
        },
        {
          type: "message",
          id: "user",
          parentId: "model",
          timestamp,
          message: { role: "user", content: [{ type: "text", text: id }], timestamp: 0 },
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
    );
    if (activityOrdering) {
      // Opening the selected runtime can write configuration. Keep the idle row
      // newer even after that write, so this genuinely tests working-first grouping.
      const modifiedAt = new Date(id === "alpha-idle" ? "2100-01-01T00:00:00.000Z" : timestamp);
      await utimes(file, modifiedAt, modifiedAt);
    }
  }
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
    await installLocalModelHttpGuard(application, origin);
    const page = await application.firstWindow();
    const pane = page.locator('[data-slot="session-pane"]');
    const row = (id: string) => page.locator(`.session-item[data-session-id="${id}"]`);
    const next = process.platform === "darwin" ? "Meta+Shift+BracketRight" : "Alt+Shift+ArrowRight";
    const previous =
      process.platform === "darwin" ? "Meta+Shift+BracketLeft" : "Alt+Shift+ArrowLeft";
    const back = process.platform === "darwin" ? "Meta+BracketLeft" : "Alt+ArrowLeft";
    const forward = process.platform === "darwin" ? "Meta+BracketRight" : "Alt+ArrowRight";
    await expect(pane).toHaveAttribute("data-session-id", "alpha-worker", { timeout: 20_000 });
    if (activityOrdering) {
      const alphaOrder = () =>
        row("alpha-worker")
          .locator('xpath=ancestor::*[@data-slot="project-group"]')
          .locator(".session-item")
          .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-session-id")));
      const composer = page.getByRole("combobox", { name: "Message", exact: true });
      await expect.poll(alphaOrder).toEqual(["alpha-idle", "alpha-worker"]);
      await composer.click();
      await expect(composer).toBeFocused();
      await page.keyboard.type("Start worker");
      await expect(composer).toHaveValue("Start worker");
      await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
      await page.keyboard.press("Enter");
      await expect(row("alpha-worker").locator('[aria-label="Running"]')).toBeVisible();
      await expect(row("alpha-worker").locator("time")).toHaveText(/^Working \d/);
      const workingStart = await row("alpha-worker").locator("time").getAttribute("datetime");
      const firstElapsed = await row("alpha-worker").locator("time").textContent();
      await expect
        .poll(() => row("alpha-worker").locator("time").textContent())
        .not.toBe(firstElapsed);
      await expect.poll(alphaOrder).toEqual(["alpha-worker", "alpha-idle"]);
      await expect(row("alpha-worker")).toHaveAttribute("data-navigation-active", "true");
      await expect(pane).toHaveAttribute("data-session-id", "alpha-worker");
      await row("alpha-idle").locator(".session-row").click();
      await expect(pane).toHaveAttribute("data-session-id", "alpha-idle");
      await composer.fill("Start idle");
      await page.keyboard.press("Enter");
      await expect(row("alpha-idle").locator('[aria-label="Running"]')).toBeVisible();
      await expect(row("alpha-idle").locator("time")).toHaveText(/^Working \d/);
      await expect(row("alpha-worker").locator("time")).toHaveAttribute("datetime", workingStart!);
      await expect.poll(alphaOrder).toEqual(["alpha-idle", "alpha-worker"]);
      await expect.poll(() => streams.length).toBe(2);
      await composer.click();
      await expect(composer).toBeFocused();
      await page.keyboard.type("Keep this unsent draft");
      await expect(composer).toHaveValue("Keep this unsent draft");
      // Completion returns the background row to live recency without navigating to it.
      streams[0]!.end(chunk("Finished.", "stop") + "data: [DONE]\n\n");
      await expect(row("alpha-worker").locator('[aria-label="Running"]')).toHaveCount(0);
      await expect(row("alpha-worker").locator("time")).not.toContainText("Working");
      await expect.poll(alphaOrder).toEqual(["alpha-idle", "alpha-worker"]);
      await expect(row("alpha-idle")).toHaveAttribute("data-navigation-active", "true");
      await expect(pane).toHaveAttribute("data-session-id", "alpha-idle");
      await expect(composer).toBeFocused();
      await expect(composer).toHaveValue("Keep this unsent draft");
      // The selected row also rejoins live recency when it stops; selection never pins it.
      streams[1]!.end(chunk("Finished.", "stop") + "data: [DONE]\n\n");
      await expect(row("alpha-idle").locator('[aria-label="Running"]')).toHaveCount(0);
      await expect.poll(alphaOrder).toEqual(["alpha-idle", "alpha-worker"]);
      await expect(row("alpha-idle")).toHaveAttribute("data-navigation-active", "true");
      await expect(row("alpha-idle").locator("time")).toHaveCount(1);
      await expect(pane).toHaveAttribute("data-session-id", "alpha-idle");
      await expect(composer).toBeFocused();
      await expect(composer).toHaveValue("Keep this unsent draft");
      return;
    }
    for (const id of ["alpha-worker", "beta-worker"]) {
      await row(id).locator(".session-row").click();
      await expect(pane).toHaveAttribute("data-session-id", id);
      const composer = page.getByRole("combobox", { name: "Message", exact: true });
      await composer.click();
      await expect(composer).toBeFocused();
      await page.keyboard.type(`Work in ${id}`);
      await expect(composer).toHaveValue(`Work in ${id}`);
      await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
      await page.keyboard.press("Enter");
      await expect(row(id).locator('[aria-label="Running"]')).toBeVisible();
    }
    await expect.poll(() => streams.length).toBe(2);
    await row("alpha-idle").locator(".session-row").click();
    await expect(pane).toHaveAttribute("data-session-id", "alpha-idle");
    await row("idle-session").locator(".session-row").click();
    await expect(pane).toHaveAttribute("data-session-id", "idle-session");
    const composer = page.getByRole("combobox", { name: "Message", exact: true });
    await composer.fill("Retained idle draft");
    await page.keyboard.press(next);
    await expect(pane).toHaveAttribute("data-session-id", "alpha-worker");
    await page.keyboard.press(next);
    await expect(pane).toHaveAttribute("data-session-id", "beta-worker");
    await page.keyboard.press(next);
    await expect(pane).toHaveAttribute("data-session-id", "alpha-worker");
    await page.keyboard.press(previous);
    await expect(pane).toHaveAttribute("data-session-id", "beta-worker");

    await page.getByRole("button", { name: "Focus on alpha" }).click();
    await expect(pane).toHaveAttribute("data-session-id", "beta-worker");
    for (const id of ["alpha-worker", "alpha-worker", "alpha-idle", "alpha-worker"]) {
      await page.keyboard.press(back);
      await expect(pane).toHaveAttribute("data-session-id", id);
    }
    await expect(page.getByRole("button", { name: "Go back in session history" })).toBeDisabled();
    for (const id of ["alpha-idle", "alpha-worker", "alpha-worker"]) {
      await page.keyboard.press(forward);
      await expect(pane).toHaveAttribute("data-session-id", id);
    }
    await expect(
      page.getByRole("button", { name: "Go forward in session history" }),
    ).toBeDisabled();
    await page.keyboard.press(next);
    await page.keyboard.press(previous);
    await expect(pane).toHaveAttribute("data-session-id", "alpha-worker");
    await page.getByRole("button", { name: "Exit focus mode for alpha" }).click();
    await page.keyboard.press(next);
    await expect(pane).toHaveAttribute("data-session-id", "beta-worker");

    streams[1]!.end(chunk("Finished.", "stop") + "data: [DONE]\n\n");
    await expect(row("beta-worker").locator('[aria-label="Running"]')).toHaveCount(0);
    await page.keyboard.press(next);
    await expect(pane).toHaveAttribute("data-session-id", "alpha-worker");
    await page.keyboard.press(previous);
    await expect(pane).toHaveAttribute("data-session-id", "alpha-worker");
    streams[0]!.end(chunk("Finished.", "stop") + "data: [DONE]\n\n");
    await expect(row("alpha-worker").locator('[aria-label="Running"]')).toHaveCount(0);
    await page.keyboard.press(next);
    await page.keyboard.press(previous);
    await expect(pane).toHaveAttribute("data-session-id", "alpha-worker");

    await row("idle-session").locator(".session-row").click();
    await expect(composer).toHaveValue("Retained idle draft");
    await page.keyboard.press(back);
    await expect(pane).toHaveAttribute("data-session-id", "alpha-worker");
    await page.keyboard.press(forward);
    await expect(pane).toHaveAttribute("data-session-id", "idle-session");
    await expect(composer).toHaveValue("Retained idle draft");
  } finally {
    await application.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}
