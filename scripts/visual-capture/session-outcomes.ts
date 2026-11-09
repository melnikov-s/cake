import { mkdir, writeFile } from "node:fs/promises";
import { defaultApplicationState } from "../../src/contracts/application/application-data";
import { windowState } from "../../tests/fixtures/window-state";
import { join, resolve } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness, createRegistry, UserEntry } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createModels } from "@earendil-works/pi-durable-ai";
import { expect } from "@playwright/test";
import {
  formatSessionDigestReminder,
  type SessionDigestLine,
} from "../../src/contracts/cake-chats/session-digest-reminder";
import type { VisualCaptureScenario } from "./scenarios";

export function createSessionOutcomesScenario(): VisualCaptureScenario {
  return {
    name: "session-outcomes",
    description:
      "Human auto-merge success, partial resolution failure, blocked merge and exact legacy system details",
    states: ["default", "details"],
    async seed(paths, theme) {
      await Promise.all([
        mkdir(paths.userData, { recursive: true }),
        mkdir(paths.project, { recursive: true }),
        mkdir(join(paths.cakeHome, "state"), { recursive: true }),
        mkdir(join(paths.cakeHome, "pi", "global-chat"), { recursive: true }),
      ]);
      await writeFile(
        join(paths.userData, "window-state.json"),
        windowState({ project: paths.project, theme }),
      );
      await writeFile(
        join(paths.cakeHome, "state", "application.json"),
        JSON.stringify({
          version: 7,
          data: {
            ...defaultApplicationState(),
            projects: [
              {
                path: paths.project,
                name: "visual-capture-project",
                addedAt: new Date(0).toISOString(),
                lastOpenedAt: new Date(0).toISOString(),
              },
            ],
          },
        }),
      );
      const outcome = {
        targetBranch: "main",
        landedCommit: "acb3bb91264b2dcbfb353878a7d44421b454ca11",
        merged: true,
        resolutionSucceeded: true,
        message: "Auto-merged and resolved",
      };
      const sessionDirectory = join(
        paths.cakeHome,
        "pi",
        "sessions",
        `--${resolve(paths.project)
          .replace(/^[/\\]/, "")
          .replace(/[/\\:]/g, "-")}--`,
      );
      await mkdir(sessionDirectory, { recursive: true });
      const timestamp = new Date(0).toISOString();
      await writeFile(
        join(sessionDirectory, "1970-01-01T00-00-00-000Z_success-source.jsonl"),
        [
          { type: "session", version: 3, id: "success-source", timestamp, cwd: paths.project },
          {
            type: "session_info",
            id: "title",
            parentId: null,
            timestamp,
            name: "Successful report source",
          },
          {
            type: "message",
            id: "report",
            parentId: "title",
            timestamp,
            message: {
              role: "assistant",
              content: [
                {
                  type: "text",
                  text: "## Original findings\n\nWorker findings remain readable. The scoped renderer check passed; no merge approval.",
                },
              ],
              api: "anthropic-messages",
              provider: "anthropic",
              model: "visual-fixture",
              usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              },
              stopReason: "stop",
              timestamp: 1,
            },
          },
        ]
          .map((entry) => JSON.stringify(entry))
          .join("\n") + "\n",
      );
      const lines: SessionDigestLine[] = [
        {
          reference: "8d0e8bf3",
          sessionId: "legacy-source",
          title: "Exclude Project Chat from working-session badge",
          status: "completed" as const,
          summary: `Auto-merge backend outcome: merged=true; resolutionSucceeded=true; targetBranch=main; landedCommit=${outcome.landedCommit}. Auto-merged and resolved`,
        },
        {
          reference: "success",
          sessionId: "success-source",
          title: "Exclude Project Chat from working-session count",
          status: "completed" as const,
          summary: "Merged and resolved",
          autoMergeOutcome: outcome,
        },
        {
          reference: "partial",
          sessionId: "partial-source",
          title: "Preserve worker reports during resolution",
          status: "blocked" as const,
          summary: "Resolution failed",
          autoMergeOutcome: {
            ...outcome,
            resolutionSucceeded: false,
            message:
              "Changes landed, but a child session is still active. Stop the child before resolving.",
          },
        },
        {
          reference: "conflict",
          sessionId: "conflict-source",
          title:
            "A long report title remains readable at narrow widths without overlapping source navigation or disclosure icons",
          status: "blocked" as const,
          summary: "Merge blocked",
          autoMergeOutcome: {
            ...outcome,
            merged: false,
            resolutionSucceeded: false,
            message:
              "Merge conflict in the report renderer. Resolve the conflict in the worktree, then retry.",
          },
        },
      ];
      lines.push({
        reference: "report",
        sessionId: "success-source",
        title: "Worker findings stay readable",
        status: "completed",
        summary: "Scoped renderer check passed",
        resultMessageRef: "cake://session/success-source?message=report",
      });
      const storage = await openNodeSqliteStorage(
        join(paths.cakeHome, "pi", "global-chat", "coordinator.sqlite"),
      );
      const harness = await Harness.open(
        storage,
        { models: createModels(), registry: createRegistry() },
        BACKGROUND_CONTEXT,
      );
      try {
        const root = await harness.root(BACKGROUND_CONTEXT);
        await root.commit(async (tx) => {
          await tx.appendEntry(UserEntry, root.id, {
            model: [
              { role: "user", content: formatSessionDigestReminder({ lines })!, timestamp: 10 },
            ],
          });
        }, BACKGROUND_CONTEXT);
      } finally {
        await harness.close(BACKGROUND_CONTEXT);
        await storage.close(BACKGROUND_CONTEXT);
      }
    },
    async prepare(page, state) {
      await page.getByRole("button", { name: "Open Cake Chat", exact: true }).first().click();
      const batch = page.getByRole("status", { name: "Session results" });
      await expect(batch).toBeVisible();
      await page.getByRole("combobox", { name: "Message Cake Chat", exact: true }).focus();
      await page.mouse.move(1, 1);
      if (state === "details") {
        // The same disclosure gesture also records the pre-fix compiled renderer for comparison.
        await batch
          .locator('[data-slot="context-pill"] button, [data-slot="response-disclosure"]')
          .first()
          .click();
      }
      await page.waitForFunction(() => document.fonts.status === "loaded");
    },
    region: (page) => page.locator(".transcript"),
  };
}
