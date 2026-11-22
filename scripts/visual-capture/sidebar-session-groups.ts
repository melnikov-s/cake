import { mkdir, utimes, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect } from "@playwright/test";
import { defaultApplicationState } from "../../src/contracts/application/application-data";
import { windowState } from "../../tests/fixtures/window-state";
import type { VisualCaptureScenario } from "./scenarios";

type Kind = "user" | "delegated";
interface FixtureSession {
  readonly id: string;
  readonly title: string;
  readonly kind: Kind;
  readonly date: string;
  readonly unread?: boolean;
  readonly resolved?: boolean;
}

const id = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
const resolvedSessions: FixtureSession[] = [
  {
    id: id(90),
    title: "Tidy release notes",
    kind: "user",
    date: "2026-01-02",
    resolved: true,
  },
  { id: id(91), title: "Audit icon sizes", kind: "delegated", date: "2026-01-03", resolved: true },
  { id: id(92), title: "Sketch onboarding", kind: "user", date: "2026-01-04", resolved: true },
];
const userSessions: FixtureSession[] = [
  { id: id(1), title: "Design the sidebar groups", kind: "user", date: "2026-02-03" },
  { id: id(2), title: "Plan the March release", kind: "user", date: "2026-02-02" },
];
const delegatedSessions: FixtureSession[] = [
  { id: id(11), title: "Fix sidebar counts", kind: "delegated", date: "2026-02-06" },
  {
    id: id(12),
    title: "Review catalog paging",
    kind: "delegated",
    date: "2026-02-05",
    unread: true,
  },
  { id: id(13), title: "Investigate flaky test", kind: "delegated", date: "2026-02-04" },
];

function sessionDirectory(root: string, project: string) {
  return join(
    root,
    `--${resolve(project)
      .replace(/^[/\\]/, "")
      .replace(/[/\\:]/g, "-")}--`,
  );
}

/** Actual Sessions groups, with persisted purpose metadata and on-demand archive rows. */
function createScenario(
  variant: "delegated" | "user" | "mixed",
  states: readonly string[],
): VisualCaptureScenario {
  const active =
    variant === "delegated"
      ? delegatedSessions
      : variant === "user"
        ? userSessions
        : [...userSessions, ...delegatedSessions];
  const selected = active.find((session) => session.kind === "user" && !session.unread);
  return {
    name: `sidebar-session-groups-${variant}`,
    description:
      variant === "mixed"
        ? "Sessions navigator with My sessions, Delegated and Resolved headers and counts"
        : `Sessions navigator with only ${variant} sessions and a Delegated header`,
    states,
    async seed(paths, theme) {
      const state = join(paths.cakeHome, "state");
      const activeDirectory = sessionDirectory(
        join(paths.cakeHome, "pi", "sessions"),
        paths.project,
      );
      // Legacy resolved namespace: the archive migrates it on first observation.
      const resolvedDirectory = sessionDirectory(
        join(paths.cakeHome, "pi", "resolved-sessions"),
        paths.project,
      );
      await Promise.all(
        [paths.userData, paths.project, state, activeDirectory, resolvedDirectory].map(
          (directory) => mkdir(directory, { recursive: true }),
        ),
      );
      const all = [...active, ...resolvedSessions];
      await Promise.all([
        writeFile(
          join(paths.userData, "window-state.json"),
          windowState({ project: paths.project, sessionId: selected?.id, theme }),
        ),
        writeFile(
          join(state, "application.json"),
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
              unreadSessionIds: all.filter((session) => session.unread).map(({ id }) => id),
            },
          }),
        ),
        writeFile(
          join(state, "session-families.json"),
          JSON.stringify({
            version: 12,
            data: {
              families: [],
              turns: [],
              spawnedSessions: [],
              sessionPurposes: all.map((session) => ({
                sessionId: session.id,
                projectPath: paths.project,
                purpose: session.kind,
                createdPurpose: session.kind,
              })),
            },
          }),
        ),
        ...all.map(async (session) => {
          const timestamp = `${session.date}T00:00:00.000Z`;
          const entries = [
            { type: "session", version: 3, id: session.id, timestamp, cwd: paths.project },
            { type: "session_info", id: "title", parentId: null, timestamp, name: session.title },
            {
              type: "message",
              id: "question",
              parentId: "title",
              timestamp,
              message: { role: "user", content: "What changed?", timestamp: 0 },
            },
          ];
          const file = join(
            session.resolved ? resolvedDirectory : activeDirectory,
            `${session.date}T00-00-00-000Z_${session.id}.jsonl`,
          );
          await writeFile(file, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
          if (session.resolved) {
            const date = new Date(timestamp);
            await utimes(file, date, date);
          }
        }),
      ]);
    },
    async prepare(page, state) {
      await page
        .getByRole("button", { name: "Open Project Chat for visual-capture-project", exact: true })
        .click();
      await page.getByRole("button", { name: /^Sessions ·/ }).click();
      const list = page.getByLabel("Session conversations", { exact: true });
      await expect(
        list.locator('[data-slot="conversation-navigator-row"][data-session-id]'),
      ).not.toHaveCount(0);
      const resolved = list.getByRole("button", { name: "Resolved sessions", exact: true });
      const group = list.getByRole("region", { name: "Delegated", exact: true });
      const disclosure = group.getByRole("button", { name: "Delegated", exact: true });
      await expect(group.getByRole("switch")).toBeVisible();
      await expect(disclosure).toHaveText(`${variant === "user" ? 0 : 3} delegated · 0 running`);
      await expect(disclosure).toHaveAttribute("aria-expanded", "false");
      const mine = list.getByRole("region", { name: "My sessions", exact: true });
      if (variant === "mixed") {
        await expect(mine).toBeVisible();
        await expect(mine.getByRole("switch")).toHaveCount(0);
      } else await expect(mine).toHaveCount(0);
      if (state === "expanded") {
        await disclosure.click();
        await expect(group.getByText("Review catalog paging", { exact: true })).toBeVisible();
      }
      if (state === "resolved-expanded") {
        await resolved.click();
        await expect(resolved.locator('[data-slot="group-count"]')).toHaveText("3");
        const history = page.getByRole("region", { name: "Resolved sessions" });
        const rows = history.locator('[data-slot="conversation-navigator-row"]');
        await expect(rows).toHaveCount(3);
        await expect(rows.nth(0)).toContainText("Sketch onboarding");
        await expect(rows.nth(1)).toContainText("Audit icon sizes");
        await expect(rows.nth(2)).toContainText("Tidy release notes");
        await expect(history.getByRole("heading")).toHaveCount(0);
        await expect(history.getByRole("region")).toHaveCount(0);
      }
      await page.mouse.move(1, 1);
    },
    region: (page) => page.locator('[data-slot="workspace-navigator"]'),
  };
}

export const sidebarSessionGroupsScenarios: VisualCaptureScenario[] = [
  createScenario("delegated", ["default"]),
  createScenario("user", ["default"]),
  createScenario("mixed", ["default", "expanded", "resolved-expanded"]),
];
