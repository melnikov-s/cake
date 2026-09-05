import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { cakeWorkspaceSessionDirectory } from "../../src/services/pi/runtime/session-discovery";
import { emitRendererEvent } from "./main-harness";

const repositoryRoot = resolve(import.meta.dirname, "../..");

test("a native-control draft remains in the limited sidebar when activated", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "cake-sidebar-control-"));
  const userData = join(temporaryRoot, "user-data");
  const project = join(temporaryRoot, "project");
  const cakeHome = join(temporaryRoot, "cake-home");
  const sessionRoot = join(cakeHome, "pi", "sessions");
  const projectSessions = cakeWorkspaceSessionDirectory(project, sessionRoot);
  await Promise.all([
    mkdir(userData, { recursive: true }),
    mkdir(project, { recursive: true }),
    mkdir(join(cakeHome, "state"), { recursive: true }),
    mkdir(projectSessions, { recursive: true }),
  ]);
  await Promise.all(
    Array.from({ length: 10 }, (_, index) =>
      writeFile(
        join(
          projectSessions,
          `2025-12-${String(20 - index).padStart(2, "0")}T00-00-00-000Z_lightweight-${index}.jsonl`,
        ),
        "",
      ),
    ),
  );
  await writeFile(
    join(userData, "window-state.json"),
    JSON.stringify({ recentProjectPaths: [project], theme: "system" }),
  );
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
    },
  });
  try {
    const page = await application.firstWindow();
    await expect(page.locator('[data-session-id="lightweight-9"]')).toBeVisible({
      timeout: 20_000,
    });
    await emitRendererEvent(application, {
      type: "project-session-control-requested",
      sessionId: "control-source",
      controlRequestId: "1f1b14db-8ca1-4e63-97ac-e7c546f553d5",
      invocation: {
        _tag: "InvokeAppControl",
        command: "sessions.create-draft",
        input: {
          workspacePath: project,
          name: "Reactive draft",
          initialPrompt: "Keep this visible",
        },
      },
    });

    const draft = page.locator(".session-item[data-session-id]", { hasText: "Reactive draft" });
    await expect(draft).toBeVisible({ timeout: 1_000 });
    await draft.click();
    await expect(page.getByRole("button", { name: "Activate draft" })).toBeVisible();
    await page.getByRole("button", { name: "Current checkout" }).click();
    await page.getByRole("button", { name: "Activate draft" }).click();

    await expect(draft).toBeVisible({ timeout: 1_000 });
  } finally {
    await application.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
