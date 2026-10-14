import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { windowState } from "../fixtures/window-state";

const repositoryRoot = resolve(import.meta.dirname, "../..");

test("shows a restored session's startup failure in the window instead of loading forever", async () => {
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
      trustedProjectPaths: [project],
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
  try {
    const page = await application.firstWindow();
    const error = page.getByRole("alert").filter({ hasText: "Could not open session" });
    await expect(error).toBeVisible({ timeout: 20_000 });
    await expect(error).toContainText(/no longer available|could not find Project Session/);
    await expect(page.getByText("Opening session", { exact: true })).toHaveCount(0);
    await expect(error.getByRole("button", { name: "Copy full error details" })).toBeVisible();
  } finally {
    await application.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
