import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "../../scripts/queued-electron.mjs";
import { expect, test } from "@playwright/test";
import { cakeWorkspaceSessionDirectory } from "../../src/services/pi/runtime/session-discovery";
import { windowState } from "../fixtures/window-state";
import { openSession, showSessions } from "./fixtures/workspace-navigation";

const repositoryRoot = resolve(import.meta.dirname, "../..");

const sessionEntries = (sessionId: string, project: string, timestamp: string, text: string) => [
  { type: "session", version: 3, id: sessionId, timestamp, cwd: project },
  {
    type: "message",
    id: `${sessionId}-user-1`,
    parentId: null,
    timestamp,
    message: { role: "user", content: [{ type: "text", text }], timestamp: 0 },
  },
];

test("navigates session history with back, forward, and resolve", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "cake-session-history-smoke-"));
  const userData = join(temporaryRoot, "user-data");
  const project = join(temporaryRoot, "project");
  const cakeHome = join(temporaryRoot, "cake-home");
  const backSessionId = "history-back-session";
  const forwardSessionId = "history-forward-session";
  const sessionDirectory = cakeWorkspaceSessionDirectory(project, join(cakeHome, "pi", "sessions"));
  const timestamp = new Date(0).toISOString();
  await Promise.all([
    mkdir(userData, { recursive: true }),
    mkdir(project, { recursive: true }),
    mkdir(sessionDirectory, { recursive: true }),
  ]);
  await writeFile(
    join(userData, "window-state.json"),
    windowState({ project, sessionId: forwardSessionId, theme: "system" }),
  );
  await mkdir(join(cakeHome, "state"), { recursive: true });
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
    }),
  );
  await Promise.all([
    writeFile(
      join(sessionDirectory, `1970-01-01T00-00-00-000Z_${backSessionId}.jsonl`),
      `${sessionEntries(backSessionId, project, timestamp, "First history session")
        .map((entry) => JSON.stringify(entry))
        .join("\n")}\n`,
    ),
    writeFile(
      join(sessionDirectory, `1970-01-01T00-00-01-000Z_${forwardSessionId}.jsonl`),
      `${sessionEntries(forwardSessionId, project, timestamp, "Second history session")
        .map((entry) => JSON.stringify(entry))
        .join("\n")}\n`,
    ),
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
    await expect(
      page.getByRole("combobox", { name: "Message Cake Chat", exact: true }),
    ).toBeVisible({ timeout: 20_000 });

    const back = page.getByRole("button", { name: "Go back in session history" });
    const forward = page.getByRole("button", { name: "Go forward in session history" });
    const activeBackSession = page.locator(
      ".session-item.active[data-session-id='history-back-session']",
    );
    const activeForwardSession = page.locator(
      ".session-item.active[data-session-id='history-forward-session']",
    );
    const backShortcut = process.platform === "darwin" ? "Meta+BracketLeft" : "Alt+ArrowLeft";
    const forwardShortcut = process.platform === "darwin" ? "Meta+BracketRight" : "Alt+ArrowRight";

    // Launch always starts in global Cake Chat (40566199), the first history entry.
    await expect(back).toBeDisabled();
    await expect(forward).toBeDisabled();
    await openSession(page, "Second history session");
    await expect(page.getByRole("combobox", { name: "Message", exact: true })).toBeVisible();
    await showSessions(page);
    await expect(activeForwardSession).toHaveCount(1);
    // Project Session history starts with the opened Session.
    await expect(back).toBeDisabled();
    await expect(forward).toBeDisabled();

    await page.locator(`.session-item[data-session-id='${backSessionId}'] .session-row`).click();
    await expect(activeBackSession).toHaveCount(1);
    await expect(back).toBeEnabled();

    await page.locator(`.session-item[data-session-id='${forwardSessionId}'] .session-row`).click();
    await expect(activeForwardSession).toHaveCount(1);
    await expect(back).toBeEnabled();
    await expect(forward).toBeDisabled();

    await page.keyboard.press(backShortcut);
    await expect(activeBackSession).toHaveCount(1);
    await expect(forward).toBeEnabled();
    await test.info().attach("history-after-keyboard-back", {
      body: await page.screenshot(),
      contentType: "image/png",
    });

    await forward.click();
    await expect(activeForwardSession).toHaveCount(1);

    await page.keyboard.press(backShortcut);
    await expect(activeBackSession).toHaveCount(1);

    await page.keyboard.press(forwardShortcut);
    await expect(activeForwardSession).toHaveCount(1);

    await activeForwardSession.locator(".session-resolve-action").click();
    // Resolving the viewed Session returns to its owning Project Chat (558a1c58) and drops
    // the resolved Session from history.
    await expect(
      page.getByRole("combobox", { name: "Message Project Chat", exact: true }),
    ).toBeVisible();
    await expect(activeForwardSession).toHaveCount(0);
    await expect(back).toBeEnabled();
    await expect(forward).toBeDisabled();
    // Resolved history lives in the Workspace Sessions list (582d0fc7).
    const resolvedLane = page.getByRole("region", { name: "Resolved sessions", exact: true });
    await page.getByRole("button", { name: "Resolved sessions", exact: true }).click();
    await expect(resolvedLane).toBeVisible();
    await expect(
      resolvedLane.locator(`.session-item.active[data-session-id="history-forward-session"]`),
    ).toHaveCount(0);

    const resolvedForwardSession = resolvedLane.locator(
      `.session-item[data-session-id="history-forward-session"]`,
    );
    await resolvedForwardSession.locator(".session-row").click();
    await expect(resolvedForwardSession).toHaveClass(/active/);
    await expect(page.getByRole("article").getByText("Second history session")).toBeVisible();
    await expect(resolvedForwardSession.locator(".session-resolve-action")).toHaveAttribute(
      "aria-label",
      /^Restore /,
    );
    // Opening an archive is an ordinary visit; Back returns to the Project Chat.
    await expect(forward).toBeDisabled();
    await back.click();
    await expect(
      page.getByRole("combobox", { name: "Message Project Chat", exact: true }),
    ).toBeVisible();
  } finally {
    await application.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
