import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { cakeWorkspaceSessionDirectory } from "../../src/services/pi/runtime/session-discovery";

const repositoryRoot = resolve(import.meta.dirname, "../..");

test("resolves and restores the selected project session in the desktop sidebar", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "cake-sidebar-resolved-smoke-"));
  const userData = join(temporaryRoot, "user-data");
  const project = join(temporaryRoot, "project");
  const cakeHome = join(temporaryRoot, "cake-home");
  const sessionId = "sidebar-resolved-session";
  const sessionDirectory = cakeWorkspaceSessionDirectory(project, join(cakeHome, "pi", "sessions"));
  const timestamp = new Date(0).toISOString();
  await Promise.all([
    mkdir(userData, { recursive: true }),
    mkdir(project, { recursive: true }),
    mkdir(sessionDirectory, { recursive: true }),
  ]);
  await writeFile(
    join(userData, "window-state.json"),
    JSON.stringify({
      projectPath: project,
      selectedSessionId: sessionId,
      activeConversation: { kind: "project-session", workspacePath: project, sessionId },
      recentProjectPaths: [project],
      draft: "",
      theme: "system",
      draftsBySession: {},
    }),
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
      trustedProjectPaths: [],
    }),
  );
  await writeFile(
    join(sessionDirectory, `1970-01-01T00-00-00-000Z_${sessionId}.jsonl`),
    [
      { type: "session", version: 3, id: sessionId, timestamp, cwd: project },
      {
        type: "message",
        id: "user-1",
        parentId: null,
        timestamp,
        message: {
          role: "user",
          content: [{ type: "text", text: "Implement the resolved sidebar" }],
          timestamp: 0,
        },
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
    },
  });

  try {
    const page = await application.firstWindow();
    await expect(page.getByLabel("Message")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("button", { name: "Collapse Cake Chat" })).toBeVisible();
    await expect(page.getByRole("button", { name: "New Cake Chat" }).first()).toBeVisible();
    await expect(page.getByRole("region", { name: "Expand Resolved" })).toHaveCount(0);

    const selectedSession = page
      .locator(".session-item.active")
      .filter({ has: page.locator(".session-resolve-action") });
    await expect(selectedSession).toHaveCount(1);
    await expect(selectedSession.locator(".session-time")).toHaveCount(1);
    await expect(selectedSession.locator(".dbga-hop")).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Ask session assistant" })).toBeVisible();
    await selectedSession.locator(".session-resolve-action").click();

    const resolvedLane = page.getByRole("region", { name: "Resolved sessions" });
    await expect(resolvedLane).toBeVisible();
    const resolvedToggle = page.getByRole("button", { name: "Expand Resolved" });
    await expect(resolvedToggle).toHaveAttribute("aria-expanded", "false");
    await resolvedToggle.click();
    await resolvedLane.getByRole("button", { name: "Expand project resolved" }).last().click();
    const resolvedSession = resolvedLane.locator(`.session-item[data-session-id="${sessionId}"]`);
    await expect(resolvedSession.getByRole("img", { name: "Resolved session" })).toBeVisible();
    await resolvedSession.locator(".session-row").click();
    await expect(page.getByRole("button", { name: "Ask session assistant" })).toHaveCount(0);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect(page.getByTestId("resolved-session-notice")).toContainText(
      "Send a message to restore this session",
    );
    await expect(page.getByRole("button", { name: "Open VS Code" })).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Open workspace changes in VS Code" }),
    ).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^Terminal/ })).toHaveCount(0);

    const restoreAction = resolvedSession.getByRole("button", { name: /^Restore / });
    await expect(restoreAction).toBeVisible();
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await restoreAction.click();
    await expect(restoreAction).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Ask session assistant" })).toBeVisible();
    await expect(selectedSession.locator(".dbga-hop")).toHaveCount(1);
    await expect(
      page.locator(`[data-slot="sidebar"] [data-session-id='${sessionId}']`),
    ).toHaveCount(1);
    const characters = page.locator('[data-slot="session-character"]');
    await expect(characters).toHaveCount(2);
    for (const character of await characters.all()) {
      await expect(character).toHaveCSS("animation-name", "session-avatar-appear");
      // Scrub the real CSS animation rather than depending on wall-clock timing.
      const poses = await character.evaluate((element) => {
        const animation = element.getAnimations()[0]!;
        animation.pause();
        const sample = (time: number) => {
          animation.currentTime = time;
          const style = getComputedStyle(element);
          return { opacity: style.opacity, scale: new DOMMatrixReadOnly(style.transform).a };
        };
        const start = sample(0);
        const overshoot = sample(250);
        animation.finish();
        return { start, overshoot, settled: sample(500) };
      });
      expect(poses.start.opacity).toBe("0");
      expect(poses.start.scale).toBeLessThan(1);
      expect(poses.overshoot.scale).toBeGreaterThan(1);
      expect(poses.settled).toEqual({ opacity: "1", scale: 1 });
    }
    await page.emulateMedia({ reducedMotion: "reduce" });
    for (const character of await characters.all()) {
      await expect(character).toHaveCSS("animation-name", "none");
      await expect(character).toHaveCSS("opacity", "1");
      await expect(character).toHaveCSS("transform", "none");
    }
  } finally {
    await application.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
