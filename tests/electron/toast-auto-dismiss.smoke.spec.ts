import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { _electron as electron } from "../../scripts/queued-electron.mjs";
import { cakeWorkspaceSessionDirectory } from "../../src/services/pi/runtime/session-discovery";
import { emitRendererEvent } from "./main-harness";

const repositoryRoot = resolve(import.meta.dirname, "../..");

test("an idle extension toast expires while a keyboard-focused toast stays", async ({}, testInfo) => {
  test.setTimeout(45_000);
  const temporaryRoot = await mkdtemp(join(tmpdir(), "cake-toast-smoke-"));
  const project = join(temporaryRoot, "project");
  const cakeHome = join(temporaryRoot, "cake-home");
  const userData = join(temporaryRoot, "user-data");
  const sessionId = "toast-fixture-session";
  const sessionDirectory = cakeWorkspaceSessionDirectory(project, join(cakeHome, "pi", "sessions"));
  const timestamp = new Date(0).toISOString();
  const sessionMessage = "Project Session for toast smoke";
  await Promise.all(
    [project, userData, sessionDirectory, join(cakeHome, "state")].map((path) =>
      mkdir(path, { recursive: true }),
    ),
  );
  await writeFile(
    join(cakeHome, "state", "application.json"),
    JSON.stringify({
      schemaVersion: 1,
      projects: [
        { path: project, name: "Toast fixture", addedAt: timestamp, lastOpenedAt: timestamp },
      ],
    }),
  );
  await writeFile(
    join(sessionDirectory, `1970-01-01T00-00-00-000Z_${sessionId}.jsonl`),
    [
      { type: "session", version: 3, id: sessionId, timestamp, cwd: project },
      {
        type: "message",
        id: "first",
        parentId: null,
        timestamp,
        message: { role: "user", content: [{ type: "text", text: sessionMessage }], timestamp: 0 },
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
    await page.getByRole("button", { name: "Search sessions", exact: true }).click();
    const search = page.getByRole("dialog", { name: "Search sessions" });
    await search.getByRole("combobox").fill(sessionMessage);
    await search.getByRole("option", { name: new RegExp(sessionMessage) }).click();
    await expect(
      page.locator(".transcript").getByText(sessionMessage, { exact: true }),
    ).toBeVisible();
    await page.mouse.move(1, 1);

    await emitRendererEvent(application, {
      type: "extension-ui-intent",
      sessionId,
      intent: { kind: "notify", id: "smoke-focus", tone: "info", message: "Keyboard dismissal" },
    });
    const focusedNotice = page.getByRole("button", { name: "Extension Keyboard dismissal" });
    await focusedNotice.focus();
    await expect(focusedNotice).toBeFocused();

    const message = "Extension could not connect";
    await emitRendererEvent(application, {
      type: "extension-ui-intent",
      sessionId,
      intent: { kind: "notify", id: "smoke-error", tone: "error", message },
    });
    const notice = page.getByRole("button", { name: `Extension ${message}` });
    await expect(notice).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath("toast-before.png"),
      animations: "disabled",
    });
    await expect(notice).toHaveCount(0, { timeout: 12_000 });
    await expect(focusedNotice).toBeFocused();
    await page.screenshot({ path: testInfo.outputPath("toast-after.png"), animations: "disabled" });
    await page.keyboard.press("Enter");
    await expect(focusedNotice).toHaveCount(0);
    await expect(
      page.locator(".transcript").getByText(sessionMessage, { exact: true }),
    ).toBeVisible();
  } finally {
    await application.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
