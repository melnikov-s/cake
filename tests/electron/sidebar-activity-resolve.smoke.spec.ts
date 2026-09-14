import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { cakeWorkspaceSessionDirectory } from "../../src/services/pi/runtime/session-discovery";

const repositoryRoot = resolve(import.meta.dirname, "../..");

// A long, multi-day feed makes per-row forced layout visible without any agent work.
test("resolving in a large Activity feed does not force layout for every shifted row", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "cake-activity-resolve-"));
  const userData = join(temporaryRoot, "user-data");
  const project = join(temporaryRoot, "project");
  const cakeHome = join(temporaryRoot, "cake-home");
  const sessionDirectory = cakeWorkspaceSessionDirectory(project, join(cakeHome, "pi", "sessions"));
  const sessionCount = 300;
  await Promise.all([
    mkdir(userData, { recursive: true }),
    mkdir(project, { recursive: true }),
    mkdir(join(cakeHome, "state"), { recursive: true }),
    mkdir(sessionDirectory, { recursive: true }),
  ]);
  await writeFile(
    join(userData, "window-state.json"),
    JSON.stringify({
      projectPath: project,
      selectedSessionId: "activity-0",
      activeConversation: {
        kind: "project-session",
        workspacePath: project,
        sessionId: "activity-0",
      },
      recentProjectPaths: [project],
      theme: "system",
    }),
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
  await Promise.all(
    Array.from({ length: sessionCount }, async (_, index) => {
      const sessionId = `activity-${index}`;
      const timestamp = new Date(
        Date.UTC(2026, 0, 10 - Math.floor(index / 75), 12, 0, -(index % 75)),
      );
      const file = join(
        sessionDirectory,
        `${timestamp.toISOString().replace(/[:.]/g, "-")}_${sessionId}.jsonl`,
      );
      const entries = [
        {
          type: "session",
          version: 3,
          id: sessionId,
          timestamp: timestamp.toISOString(),
          cwd: project,
        },
        {
          type: "message",
          id: `${sessionId}-user`,
          parentId: null,
          timestamp: timestamp.toISOString(),
          message: {
            role: "user",
            content: [{ type: "text", text: `Activity session ${index}` }],
            timestamp: timestamp.getTime(),
          },
        },
      ];
      await writeFile(file, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
      await utimes(file, timestamp, timestamp);
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
    await page.emulateMedia({ reducedMotion: "no-preference" });
    const sidebar = page.locator('[data-slot="sidebar"]');
    await expect(sidebar.locator('[data-slot="project-group"] .session-item')).toHaveCount(10, {
      timeout: 20_000,
    });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Performance.enable");
    let remaining = sessionCount;
    // Compare the limited Project view, then repeat resolution in the full feed.
    for (const [index, mode] of ["projects", "activity", "activity"].entries()) {
      if (index === 1) {
        await sidebar.getByRole("button", { name: "Show activity", exact: true }).click();
        await expect(
          sidebar.locator(
            '[data-slot="activity-feed"] section:has(.session-item[data-session-id^="activity-"])',
          ),
        ).toHaveCount(4);
      }
      const scope = sidebar.locator(
        mode === "projects" ? '[data-slot="project-group"]' : '[data-slot="activity-feed"]',
      );
      const rows = scope.locator('.session-item[data-session-id^="activity-"]');
      await expect(rows).toHaveCount(mode === "projects" ? 10 : remaining);
      const target = rows.first();
      const sessionId = await target.getAttribute("data-session-id");
      const action = target.locator(".session-resolve-action");
      await action.hover();
      await expect
        .poll(() =>
          sidebar.evaluate(
            (element) =>
              element
                .getAnimations({ subtree: true })
                .filter((animation) => animation.playState === "running").length,
          ),
        )
        .toBe(0);
      const before = await cdp.send("Performance.getMetrics");
      await action.click();
      remaining -= 1;
      await expect(scope.locator(`[data-session-id="${sessionId}"]`)).toHaveCount(0);
      await expect(rows).toHaveCount(mode === "projects" ? 10 : remaining);
      const after = await cdp.send("Performance.getMetrics");
      const delta = (name: string) =>
        after.metrics.find((metric) => metric.name === name)!.value -
        before.metrics.find((metric) => metric.name === name)!.value;
      await test.info().attach(`${mode}-resolve-${index}-metrics`, {
        contentType: "application/json",
        body: JSON.stringify({
          layouts: delta("LayoutCount"),
          styles: delta("RecalcStyleCount"),
          layoutMs: delta("LayoutDuration") * 1000,
          scriptMs: delta("ScriptDuration") * 1000,
          taskMs: delta("TaskDuration") * 1000,
        }),
      });
      // Assert layout counts, not elapsed time: allow incidental focus/highlight
      // work, but never one forced layout for each of the ~300 shifted rows.
      expect(delta("LayoutCount")).toBeLessThan(60);
    }
    await cdp.detach();
  } finally {
    await application.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
