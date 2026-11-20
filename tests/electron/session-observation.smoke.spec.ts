import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "../../scripts/queued-electron.mjs";
import { expect, test } from "@playwright/test";
import { cakeWorkspaceSessionDirectory } from "../../src/services/pi/runtime/session-discovery";
import { seedCakeChatHistory } from "./durable-chat-fixture";
import { windowState } from "../fixtures/window-state";

import { createSessionInProject, showSessions } from "./fixtures/workspace-navigation";
import { fixtureDefaultPreset, writeFixtureModels } from "./fixtures/fixture-model";

const repositoryRoot = resolve(import.meta.dirname, "../..");

test("selects multiple project sessions and Cake Chat with independent transcripts", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "cake-observation-smoke-"));
  const userData = join(temporaryRoot, "user-data");
  const project = join(temporaryRoot, "project");
  const cakeHome = join(temporaryRoot, "cake-home");
  const projectSessions = cakeWorkspaceSessionDirectory(project, join(cakeHome, "pi", "sessions"));
  const cakeChatText = "Cake observation transcript";
  await seedCakeChatHistory(cakeHome, cakeChatText);
  const timestamp = new Date(0).toISOString();
  const sessions = [
    {
      id: "observation-one",
      title: "First observation transcript",
      directory: projectSessions,
      cwd: project,
    },
    {
      id: "observation-two",
      title: "Second observation transcript",
      directory: projectSessions,
      cwd: project,
    },
  ];
  await Promise.all(
    [userData, project, projectSessions, join(cakeHome, "state")].map((path) =>
      mkdir(path, { recursive: true }),
    ),
  );
  await writeFile(
    join(userData, "window-state.json"),
    windowState({ project, sessionId: sessions[0]!.id, theme: "dark" }),
  );
  await writeFile(
    join(cakeHome, "state", "application.json"),
    JSON.stringify({
      schemaVersion: 1,
      projects: [{ path: project, name: "project", addedAt: timestamp, lastOpenedAt: timestamp }],
      // Observed conversations start their runtimes only with a model (81eb383b).
      ...fixtureDefaultPreset(),
    }),
  );
  // Never prompted: observation only opens existing conversations.
  await writeFixtureModels(cakeHome, { baseUrl: "http://127.0.0.1:1/v1" });
  for (const directory of [projectSessions]) {
    await writeFile(
      join(directory, ".pi-session-metadata.json"),
      JSON.stringify({
        version: 1,
        sessions: Object.fromEntries(
          sessions
            .filter((session) => session.directory === directory)
            .map((session) => [session.id, { title: session.title }]),
        ),
      }),
    );
  }
  for (const session of sessions) {
    await writeFile(
      join(session.directory, `1970-01-01T00-00-00-000Z_${session.id}.jsonl`),
      [
        { type: "session", version: 3, id: session.id, timestamp, cwd: session.cwd },
        // Entry IDs are local to a Pi session and may repeat across loaded projections.
        {
          type: "message",
          id: "shared-user-entry",
          parentId: null,
          timestamp,
          message: { role: "user", content: [{ type: "text", text: session.title }], timestamp: 0 },
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
    );
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
    const page = await application.firstWindow();
    const failures: string[] = [];
    page.on("pageerror", (error) => failures.push(error.message));
    page.on("console", (message) => {
      if (message.text().includes("observation failed")) failures.push(message.text());
    });
    await page.locator("body").waitFor({ state: "attached" });
    await page.evaluate(() => {
      const flashes: string[] = [];
      Object.assign(window, { emptySessionFlashes: flashes });
      new MutationObserver(() => {
        for (const heading of document.querySelectorAll(".transcript h1")) {
          const text = heading.textContent ?? "";
          if (text.includes("What should we build") || text.includes("What can I help"))
            flashes.push(text);
        }
      }).observe(document.body, { childList: true, subtree: true });
    });
    // Launch starts in global Cake Chat (40566199); its Sessions list spans every Project.
    await showSessions(page);
    for (const session of [...sessions, sessions[0]!, sessions[1]!]) {
      await page.locator(`.session-item[data-session-id="${session.id}"] .session-row`).click();
      await expect(
        page.locator(".transcript").getByText(session.title, { exact: true }),
      ).toBeVisible();
    }
    await page
      .getByRole("navigation", { name: "Projects and global utilities" })
      .getByRole("button", { name: "Open Cake Chat", exact: true })
      .click();
    await expect(
      page.getByRole("combobox", { name: "Message Cake Chat", exact: true }),
    ).toBeVisible();
    await expect(
      page.locator(".transcript").getByText(cakeChatText, { exact: true }),
    ).toBeVisible();
    await page.locator(`.session-item[data-session-id="${sessions[0]!.id}"] .session-row`).click();
    await expect(
      page.locator(".transcript").getByText(sessions[0]!.title, { exact: true }),
    ).toBeVisible();
    expect(failures).toEqual([]);
    expect(await page.evaluate(() => Reflect.get(window, "emptySessionFlashes"))).toEqual([]);
    await createSessionInProject(page, /^project(?: |$)/i);
    await expect(
      page
        .locator(".transcript")
        .getByRole("heading", { name: "What should we build in project?" }),
    ).toBeVisible();
  } finally {
    await application.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
