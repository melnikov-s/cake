import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "@playwright/test";
import { cakeWorkspaceSessionDirectory } from "../../src/services/pi/runtime/session-discovery";
import type { VisualCaptureScenario } from "./scenarios";

/** Real persisted stale to-do repair, with retained readiness and resolution metadata. */
export function createTodoResolvedSessionScenario(
  base: VisualCaptureScenario,
): VisualCaptureScenario {
  return {
    name: "todo-resolved-session",
    description:
      "Resolved linked session icon and status after persisted landing-hold reconciliation",
    states: ["default"],
    async seed(paths, theme) {
      await base.seed(paths, theme);
      const file = join(paths.cakeHome, "state", "application.json");
      const application = JSON.parse(await readFile(file, "utf8"));
      const item = application.data.projects[0].todos.items[1];
      item.title = "Keep header logo visible with truncated titles";
      item.description = "Header fix is complete. The linked Project Session is resolved.";
      item.remainingWork = "Landing hold; owning project is unavailable; fresh readiness required";
      item.associations[0].title = "Header logo correction";
      await writeFile(file, JSON.stringify(application));
      const sessionId = item.associations[0].sessionId;
      const directory = cakeWorkspaceSessionDirectory(
        paths.project,
        join(paths.cakeHome, "pi", "sessions"),
      );
      const metadata = join(paths.cakeHome, "state", "resolved-project-metadata");
      await mkdir(metadata, { recursive: true });
      await writeFile(
        join(metadata, "resolution.json"),
        JSON.stringify({ version: 1, directories: { [directory]: [sessionId] } }),
      );
      const families = join(paths.cakeHome, "state", "session-families.json");
      const autoMergeRequests = [
        {
          id: "stale-header-readiness",
          sessionId,
          workspacePath: paths.project,
          readyToMerge: true,
          epoch: "old",
          runId: "old",
          commit: "a".repeat(40),
          state: "canceled",
          message: "Owning project is unavailable; fresh readiness required",
        },
      ];
      await writeFile(
        families,
        JSON.stringify({
          version: 12,
          data: { families: [], turns: [], spawnedSessions: [], autoMergeRequests },
        }),
      );
    },
    async prepare(page) {
      await base.prepare(page, "open");
      const workspace = page.getByRole("complementary", { name: "Workspace", exact: true });
      const done = workspace.getByRole("button", { name: "Done (2)", exact: true });
      await expect(done).toBeVisible();
      if ((await done.getAttribute("aria-expanded")) !== "true") await done.click();
      const row = workspace.locator('[data-todo-id="00000000-0000-4000-8000-000000000012"]');
      await expect(row).toHaveAttribute("data-todo-section", "Done");
      await expect(
        row.getByRole("status", { name: "Session status for Header logo correction" }),
      ).toHaveText("Resolved");
      await expect(row.locator('[data-slot="resolved-session-icon"] svg')).toBeVisible();
      await expect(row.getByLabel("Merge status for Header logo correction")).toHaveCount(0);
      await page.mouse.move(1, 1);
    },
    region: (page) => page.getByRole("complementary", { name: "Workspace", exact: true }),
  };
}
