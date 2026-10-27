import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { defaultApplicationState } from "../../src/contracts/application/application-data";
import { cakeWorkspaceSessionDirectory } from "../../src/services/pi/runtime/session-discovery";
import { windowState } from "../fixtures/window-state";

const repositoryRoot = resolve(import.meta.dirname, "../..");

for (const mode of ["projects", "activity"] as const) {
  test(`sidebar session activation happens before mouseup in ${mode}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "cake-sidebar-activation-"));
    const userData = join(directory, "user-data");
    const project = join(directory, "project");
    const cakeHome = join(directory, "cake-home");
    const sessionDirectory = cakeWorkspaceSessionDirectory(
      project,
      join(cakeHome, "pi", "sessions"),
    );
    const timestamp = new Date(0).toISOString();
    await Promise.all([
      mkdir(userData, { recursive: true }),
      mkdir(project, { recursive: true }),
      mkdir(join(cakeHome, "state"), { recursive: true }),
      mkdir(sessionDirectory, { recursive: true }),
    ]);
    await writeFile(
      join(userData, "window-state.json"),
      windowState({ project, sessionId: "selected" }),
    );
    await writeFile(
      join(cakeHome, "state", "application.json"),
      JSON.stringify({
        version: 7,
        data: {
          ...defaultApplicationState(),
          projects: [
            { path: project, name: "project", addedAt: timestamp, lastOpenedAt: timestamp },
          ],
          trustedProjectPaths: [project],
        },
      }),
    );
    for (const sessionId of ["selected", "target", "resolve"]) {
      await writeFile(
        join(sessionDirectory, `1970-01-01T00-00-00-000Z_${sessionId}.jsonl`),
        [
          { type: "session", version: 3, id: sessionId, timestamp, cwd: project },
          {
            type: "message",
            id: `${sessionId}-user`,
            parentId: null,
            timestamp,
            message: { role: "user", content: [{ type: "text", text: sessionId }], timestamp: 0 },
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
      const sidebar = page.locator('[data-slot="sidebar"]');
      const pane = page.locator('[data-slot="session-pane"]');
      const row = (id: string) => sidebar.locator(`[data-session-id="${id}"]`);
      const action = (id: string) => row(id).locator(".session-row > button");
      await expect(pane).toHaveAttribute("data-session-id", "selected", { timeout: 20_000 });
      if (mode === "activity")
        await sidebar.getByRole("button", { name: "Show activity", exact: true }).click();

      await page.evaluate(() => performance.mark("cake.session-switch.enabled"));
      const openEntries = () =>
        page.evaluate(
          () =>
            (
              performance.getEntriesByName("cake.session-switch", "mark") as PerformanceMark[]
            ).filter((mark) => mark.detail.phase === "start" && mark.detail.source === "navigation")
              .length,
        );

      // Hold the primary button: navigation must finish without a release/click.
      await action("target").hover();
      await page.mouse.down();
      await expect(row("target")).toHaveAttribute("data-navigation-active", "true");
      await expect(pane).toHaveAttribute("data-session-id", "target");
      expect(await openEntries()).toBe(1);
      await page.mouse.up();
      await expect(pane).toHaveAttribute("data-session-id", "target");
      expect(await openEntries()).toBe(1);

      // Real Chromium button keyboard activation (both Enter and Space).
      await action("selected").focus();
      await page.keyboard.press("Enter");
      await expect(pane).toHaveAttribute("data-session-id", "selected");
      await action("target").focus();
      await page.keyboard.press("Space");
      await expect(pane).toHaveAttribute("data-session-id", "target");
      expect(await openEntries()).toBe(3);

      await action("selected").click({ button: "middle" });
      await expect(pane).toHaveAttribute("data-session-id", "target");

      // The leading label picker opens its own popover without navigating.
      await row("selected")
        .getByRole("button", { name: /^Change session labels/ })
        .click();
      await expect(page.getByRole("group", { name: "Session labels", exact: true })).toBeVisible();
      await expect(pane).toHaveAttribute("data-session-id", "target");
      await page.keyboard.press("Escape");

      // Resolve is a sibling button: neither its press nor its click may select its row.
      const resolveAction = row("resolve").getByRole("button", { name: /^Resolve / });
      await resolveAction.hover();
      await page.mouse.down();
      await expect(pane).toHaveAttribute("data-session-id", "target");
      await expect(row("resolve")).toHaveAttribute("data-navigation-active", "false");
      await page.mouse.up();
      await expect(row("resolve")).toHaveCount(0);
      await expect(pane).toHaveAttribute("data-session-id", "target");
      expect(await openEntries()).toBe(3);
      expect(
        await application.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().every(
            (window) => !window.isVisible() && !window.isFocused(),
          ),
        ),
      ).toBe(true);
    } finally {
      await application.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}
