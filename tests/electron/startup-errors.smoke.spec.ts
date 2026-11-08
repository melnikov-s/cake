import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "../../scripts/queued-electron.mjs";
import { expect, test } from "@playwright/test";
import { windowState } from "../fixtures/window-state";

const repositoryRoot = resolve(import.meta.dirname, "../..");

test("cold launch opens global Cake Chat instead of restoring a missing Project Session", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "cake-startup-errors-"));
  const userData = join(temporaryRoot, "user-data");
  const project = join(temporaryRoot, "project");
  const cakeHome = join(temporaryRoot, "cake-home");
  await Promise.all(
    [userData, project, join(cakeHome, "state")].map((path) => mkdir(path, { recursive: true })),
  );
  // The persisted window still points at a Pi session whose file is no longer available.
  await writeFile(
    join(userData, "window-state.json"),
    windowState({ project, sessionId: "missing-restored-session", theme: "dark" }),
  );
  const timestamp = new Date(0).toISOString();
  await writeFile(
    join(cakeHome, "state", "application.json"),
    JSON.stringify({
      schemaVersion: 1,
      projects: [{ path: project, name: "project", addedAt: timestamp, lastOpenedAt: timestamp }],
    }),
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
  let closed = false;
  try {
    const page = await application.firstWindow();
    const composer = page.getByRole("combobox", { name: "Message Cake Chat", exact: true });
    await expect(composer).toBeVisible({ timeout: 20_000 });
    await expect(composer).toHaveValue("");
    await expect(page.getByRole("combobox", { name: "Message", exact: true })).toHaveCount(0);
    await expect(page.getByText("Opening session", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("alert").filter({ hasText: "Could not open session" })).toHaveCount(
      0,
    );
    await application.close();
    closed = true;
    // Shutdown flushes the operational logger; all receipts belong to this isolated profile.
    const log = await readFile(join(cakeHome, "logs", "desktop.log"), "utf8");
    const bootstrap = log.split("\n").find((line) => line.includes('"phase":"desktop-bootstrap"'));
    expect(bootstrap).toBeDefined();
    for (const phase of [
      "entryMs",
      "importsCompletedMs",
      "profileClaimedMs",
      "graphConstructedMs",
      "loggingStartedMs",
      "loggingCompletedMs",
    ])
      expect(bootstrap).toContain(`"${phase}":`);
    expect(log).toContain('"phase":"electron-window-start"');
    expect(log).toContain('"phase":"backend-recovery-ready"');
    console.info(
      "Isolated startup receipts (one empty-profile sample, not a before/after benchmark)",
      log
        .split("\n")
        .filter((line) =>
          [
            "desktop-bootstrap",
            "backend-graph",
            "backend-recovery-ready",
            "window-created",
            "first-commit",
            "selected-chat-projection-commit",
          ].some((phase) => line.includes(`"phase":"${phase}"`)),
        ),
    );
  } finally {
    if (!closed) await application.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
