import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "@playwright/test";
import type { VisualCaptureScenario } from "./scenarios";
import { recoveryRecordFileName } from "../../src/services/storage/internal/recoveryRecordFiles";
import { subagentLink } from "../../src/contracts/subagents/subagent-reference";
import { SubagentHandleId } from "../../src/contracts/subagents/subagent-data";
import type { SubagentHistory } from "../../src/services/storage/SubagentStorage";
import { investigatorOrigin } from "../../tests/fixtures/subagent-report";

const longTitle =
  "Deep consultant review of Cake architecture and APIs, including navigation, workspace controls and session ownership";
const shortTitle = "Review";
const subagentTitle =
  "Read-only contextual investigation, no code changes, installs, generated files or Git mutations. Inspect the existing navigation and report evidence without changing the repository. ".repeat(
    4,
  );

const handleId = SubagentHandleId.make(investigatorOrigin.handleId);

/** Real header layout and hit targets with isolated synthetic transcripts and a retained worker. */
export function createSessionHeaderTitleScenario(
  base: VisualCaptureScenario,
): VisualCaptureScenario {
  return {
    name: "session-header-title",
    description:
      "Single-line breadcrumb ellipsis without scrollbars, with usable adjacent controls",
    states: ["long-title", "short-title", "long-subagent-title", "project-chat"],
    async seed(paths, theme) {
      const cleanup = await base.seed(paths, theme);
      const directory = join(
        paths.cakeHome,
        "pi",
        "sessions",
        `--${paths.project.replace(/^\//, "").replace(/\//g, "-")}--`,
      );
      const originalId = "visual-assistant-markdown-code";
      const originalFile = join(directory, `1970-01-01T00-00-00-000Z_${originalId}.jsonl`);
      const original = await readFile(originalFile, "utf8");
      const assistant = original
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
        .find((entry) => entry.message?.role === "assistant").message;
      const privateDirectory = join(paths.cakeHome, "pi", "subagent-sessions");
      const privateWorkspaceDirectory = join(privateDirectory, directory.split("/").at(-1)!);
      const historyDirectory = join(paths.cakeHome, "state", "private-worker-history");
      await mkdir(privateWorkspaceDirectory, { recursive: true });
      await mkdir(historyDirectory, { recursive: true });
      const privateId = "10000000-0000-4000-8000-000000000099";
      const history: SubagentHistory = {
        handleId,
        privateSessionId: privateId,
        parentSessionId: "visual-short-header-title",
        parentWorkingDirectory: paths.project,
        anchorPartId: "assistant-1",
        workingDirectory: paths.project,
        sessionDirectory: privateDirectory,
        task: subagentTitle,
        status: "complete",
        resolvedModel: investigatorOrigin.resolvedModel,
        fastMode: false,
      };
      await writeFile(
        join(historyDirectory, recoveryRecordFileName(handleId)),
        JSON.stringify({ version: 1, data: history }),
      );
      await writeFile(
        join(privateWorkspaceDirectory, `1970-01-01T00-00-00-000Z_${privateId}.jsonl`),
        original.replace(originalId, privateId),
      );
      for (const [id, title] of [
        [originalId, longTitle],
        ["visual-short-header-title", shortTitle],
      ] as const) {
        await writeFile(
          join(directory, `1970-01-01T00-00-00-000Z_${id}.jsonl`),
          original.replace(originalId, id) +
            JSON.stringify({
              type: "session_info",
              id: "header-title",
              parentId: "assistant-1",
              timestamp: new Date(0).toISOString(),
              name: title,
            }) +
            "\n" +
            JSON.stringify({
              type: "message",
              id: "worker-link",
              parentId: "header-title",
              timestamp: new Date(1).toISOString(),
              message: {
                ...assistant,
                content: [
                  { type: "text", text: `[Inspect header worker](${subagentLink(id, handleId)})` },
                ],
                timestamp: 1,
              },
            }) +
            "\n",
        );
      }
      return cleanup;
    },
    async prepare(page, state) {
      const subagent = state === "long-subagent-title";
      const projectChat = state === "project-chat";
      const sessionTitle = state === "short-title" || subagent ? shortTitle : longTitle;
      const title = subagent
        ? subagentTitle
        : projectChat
          ? "visual-capture-project"
          : sessionTitle;
      const openSession = async () => {
        await page.getByRole("button", { name: "Search sessions", exact: true }).first().click();
        await page.keyboard.type(sessionTitle);
        await page
          .getByRole("option", { name: new RegExp(sessionTitle) })
          .first()
          .click();
      };
      await page
        .getByRole("button", { name: "Open Project Chat for visual-capture-project", exact: true })
        .click();
      if (!projectChat) await openSession();
      if (subagent) {
        await page.getByRole("link", { name: "Inspect header worker", exact: true }).click();
        await expect(page.locator('[data-slot="focused-secondary-conversation"]')).toBeVisible();
      }
      const breadcrumb = page.getByRole("navigation", { name: "Conversation breadcrumb" });
      const current = breadcrumb.getByRole("button", { name: title, exact: true });
      await expect(current).toHaveAttribute("aria-current", "page");
      await expect(current).toHaveAttribute("title", projectChat ? /\/project$/ : title);
      await page.waitForFunction(() => document.fonts.status === "loaded");

      const geometry = await current.evaluate((button) => {
        const label = button.querySelector(":scope > span:last-child")!;
        const nav = button.closest("nav")!;
        const labelStyle = getComputedStyle(label);
        const navStyle = getComputedStyle(nav);
        const modes = document.querySelector('[data-slot="workspace-mode"]')!;
        const home = nav.querySelector("button")!;
        const avatar = home.querySelector('[data-slot="avatar"]')!;
        const homeBounds = home.getBoundingClientRect();
        const avatarBounds = avatar.getBoundingClientRect();
        const navBounds = nav.getBoundingClientRect();
        return {
          homeWidth: homeBounds.width,
          avatarWidth: avatarBounds.width,
          avatarInsideHome:
            avatarBounds.left >= homeBounds.left && avatarBounds.right <= homeBounds.right,
          homeInsideNav: homeBounds.left >= navBounds.left && homeBounds.right <= navBounds.right,
          labelWidth: label.clientWidth,
          labelScrollWidth: label.scrollWidth,
          textOverflow: labelStyle.textOverflow,
          whiteSpace: labelStyle.whiteSpace,
          labelOverflow: labelStyle.overflow,
          navOverflowX: navStyle.overflowX,
          navOverflowY: navStyle.overflowY,
          navExtraWidth: nav.scrollWidth - nav.clientWidth,
          navExtraHeight: nav.scrollHeight - nav.clientHeight,
          beforeModes: nav.getBoundingClientRect().right <= modes.getBoundingClientRect().left,
        };
      });
      expect(geometry.avatarWidth).toBe(18);
      expect(geometry.avatarInsideHome, JSON.stringify(geometry)).toBe(true);
      expect(geometry.homeInsideNav).toBe(true);
      expect(geometry.homeWidth).toBeGreaterThanOrEqual(26);
      expect(geometry.labelWidth).toBeGreaterThan(20);
      expect(geometry.textOverflow).toBe("ellipsis");
      expect(geometry.whiteSpace).toBe("nowrap");
      expect(geometry.labelOverflow).toBe("hidden");
      expect(geometry.navOverflowX).toBe("hidden");
      expect(geometry.navOverflowY).toBe("hidden");
      expect(geometry.navExtraWidth).toBeLessThanOrEqual(1);
      expect(geometry.navExtraHeight).toBeLessThanOrEqual(1);
      expect(geometry.beforeModes).toBe(true);
      if (state === "long-title" || subagent)
        expect(geometry.labelScrollWidth).toBeGreaterThan(geometry.labelWidth);
      else expect(geometry.labelScrollWidth).toBe(geometry.labelWidth);

      // An ellipsis assertion alone misses a logo clipped inside a shrinking home button.
      // Check every breadcrumb and adjacent action's complete bounds and real hit target.
      const header = page.locator('[data-slot="workspace-header"]');
      const viewportWidth = await page.evaluate(() => innerWidth);
      for (const button of await header.getByRole("button").all()) {
        if (!(await button.isVisible()) || !(await button.isEnabled())) continue;
        const bounds = await button.boundingBox();
        expect(bounds!.x).toBeGreaterThanOrEqual(0);
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewportWidth);
        await button.click({ trial: true });
      }
      for (const button of await breadcrumb.getByRole("button").all()) {
        expect(
          await button.evaluate((element) => {
            const bounds = element.getBoundingClientRect();
            const nav = element.closest("nav")!.getBoundingClientRect();
            const label = element.querySelector(":scope > span:last-child")!;
            return bounds.left >= nav.left && bounds.right <= nav.right && label.clientWidth > 20;
          }),
        ).toBe(true);
      }
      // Trial clicks prove real hit targets aren't covered by the title.
      for (const name of ["Main", "VS Code", "Browser"])
        await page.getByRole("button", { name, exact: true }).click({ trial: true });
      await page.getByRole("button", { name: "Browser", exact: true }).click();
      await expect(page.getByRole("textbox", { name: "Browser address" })).toBeVisible();
      await page.getByRole("button", { name: "Main", exact: true }).click();
      await expect(current).toBeVisible();
      // Project navigation still works, and the same session can be reopened.
      await breadcrumb.getByRole("button", { name: "visual-capture-project", exact: true }).click();
      await expect(
        page.getByRole("combobox", { name: "Message Project Chat", exact: true }),
      ).toBeVisible();
      if (!projectChat) await openSession();
      // Reopening the parent asynchronously restores its selected worker, too.
      await expect(current).toBeVisible();
      await page.mouse.move(1, 100);
      console.log("SESSION_HEADER_TITLE_GEOMETRY", JSON.stringify({ state, ...geometry }));
    },
    region: (page) => page.locator('[data-slot="workspace-header"]'),
  };
}
