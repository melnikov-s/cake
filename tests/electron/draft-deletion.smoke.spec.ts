import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "../../scripts/queued-electron.mjs";
import { expect, test } from "@playwright/test";
import { windowState } from "../fixtures/window-state";
import type { SavedDraft } from "../../src/contracts/project-sessions/saved-draft-data";

const repositoryRoot = resolve(import.meta.dirname, "../..");

test("Delete removes a saved draft, while historical resolved drafts stay stored but out of history", async ({}, testInfo) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "cake-draft-deletion-"));
  const userData = join(temporaryRoot, "user-data");
  const project = join(temporaryRoot, "project");
  const cakeHome = join(temporaryRoot, "cake-home");
  const state = join(cakeHome, "state");
  const sessionId = "00000000-0000-4000-8000-000000000001";
  const historicalId = "00000000-0000-4000-8000-000000000002";
  const draft: SavedDraft = {
    sessionId,
    projectPath: project,
    workingDirectory: project,
    title: "Planned work",
    text: "Unsent plan",
    attachments: [],
    labelIds: [],
    resolved: false,
    createdAt: new Date(0).toISOString(),
    modifiedAt: new Date(0).toISOString(),
    revision: 1,
    status: "saved",
  };
  const historical: SavedDraft = {
    ...draft,
    sessionId: historicalId,
    title: "Historical resolved draft",
    text: "Preserved historical plan",
    resolved: true,
  };
  const savedDraftFile = join(state, "saved-drafts.json");
  await Promise.all([
    mkdir(userData, { recursive: true }),
    mkdir(project, { recursive: true }),
    mkdir(state, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(
      join(userData, "window-state.json"),
      windowState({ project, sessionId, theme: "light" }),
    ),
    writeFile(
      join(state, "application.json"),
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
      }),
    ),
    writeFile(savedDraftFile, JSON.stringify({ version: 1, records: [draft, historical] })),
  ]);
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
    await page.getByRole("button", { name: "Open Project Chat for project", exact: true }).click();
    await page.getByRole("button", { name: /^Sessions ·/ }).click();
    await page
      .locator(`[data-session-id="${sessionId}"]`)
      .getByText("Planned work", { exact: true })
      .click();
    await expect(page.getByText("Unsent plan", { exact: true })).toBeVisible({ timeout: 20_000 });
    const remove = page.getByRole("button", { name: "Delete Planned work", exact: true });
    await expect(remove).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Resolve Planned work", exact: true }),
    ).toHaveCount(0);
    await page.getByRole("button", { name: "Resolved sessions", exact: true }).click();
    await expect(page.getByText(historical.title, { exact: true })).toHaveCount(0);
    await remove.hover();
    await expect(page.getByRole("tooltip", { name: "Delete", exact: true })).toBeVisible();
    const screenshot = testInfo.outputPath("draft-delete.png");
    await page.screenshot({ path: screenshot });
    await testInfo.attach("Draft action is Delete", { path: screenshot, contentType: "image/png" });
    await remove.click();
    await expect(page.locator(`[data-session-id="${sessionId}"]`)).toHaveCount(0);
    await expect(page.getByText("Unsent plan", { exact: true })).toHaveCount(0);
    await expect
      .poll(async () => JSON.parse(await readFile(savedDraftFile, "utf8")).records)
      .toEqual([historical]);
    await expect(
      page.getByRole("button", { name: "Restore Planned work", exact: true }),
    ).toHaveCount(0);
    await expect(page.getByText(historical.title, { exact: true })).toHaveCount(0);
  } finally {
    await application.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
