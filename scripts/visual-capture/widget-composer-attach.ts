import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { NodeFileSystem, NodePath } from "@effect/platform-node-shared";
import { expect, type Page } from "@playwright/test";
import { Effect, Layer, Schema } from "effect";
import type { CakeArtifactV1 } from "../../src/contracts/artifacts/artifact-contract";
import { ArtifactLineageId } from "../../src/contracts/artifacts/artifact-lineage";
import type { JsonObject } from "../../src/contracts/serialization/json-contract";
import type { WidgetBrowserOutput } from "../../src/contracts/widgets/widget-browser-output";
import { ArtifactStorage } from "../../src/services/storage/ArtifactStorage";
import { makeArtifactStorageLive } from "../../src/services/storage/ArtifactStorageLive";
import type { VisualCaptureScenario } from "./scenarios";

type Seed = VisualCaptureScenario["seed"];
const title = "Delta PRs";
const id = "delta-pr-tracker";

// Synthetic rows only; the widget source is the real Delta PRs revision using cake.composer.attach.
const prs = [
  [
    48121,
    "Retry flaky checkout payment test with deterministic clock",
    "ready_to_merge",
    "Approved · CI green",
  ],
  [48107, "Cache shipping zone lookups per request", "blocked", "Blocked: 3 open Binks findings"],
  [
    48093,
    "Move tax rounding into the money value object",
    "waiting_on_review",
    "Review requested 2 h ago",
  ],
] as const;

type Dependencies = {
  seedArtifact: (
    paths: Parameters<Seed>[0],
    theme: Parameters<Seed>[1],
    artifact: CakeArtifactV1,
    inline: boolean,
  ) => ReturnType<Seed>;
  retainBrowser: (
    paths: Parameters<Seed>[0],
    language: "html",
    source: string,
  ) => Promise<WidgetBrowserOutput>;
  openSession: (page: Page, project: string, title: string) => Promise<void>;
};

// Seeds the real Delta PRs widget source inline in a chat, with the given saved state rows.
async function seedDeltaPrs(
  dependencies: Dependencies,
  paths: Parameters<Seed>[0],
  theme: Parameters<Seed>[1],
  sessionId: string,
  rows: {
    authored: JsonObject[];
    reviewRequests: JsonObject[];
    refreshedAt: string;
    mergeOverrides?: JsonObject;
    fixRequests?: JsonObject;
  },
) {
  const source = await readFile(
    resolve(import.meta.dirname, "../../tests/fixtures/widgets/delta-pr-tracker.html"),
    "utf8",
  );
  await dependencies.seedArtifact(
    paths,
    theme,
    {
      protocol: "cake.artifact/v1",
      id,
      sessionId,
      revision: 1,
      kind: "widget",
      title,
      payload: {
        language: "html",
        source,
        brief: "Delta PRs dashboard with per-row composer attach",
        generationSessionId: `${sessionId}-fixture`,
        browser: await dependencies.retainBrowser(paths, "html", source),
      },
      fallback: { markdown: title },
      interaction: { mode: "present" },
    },
    true,
  );
  await Effect.runPromise(
    Effect.gen(function* () {
      const storage = yield* ArtifactStorage;
      yield* storage.replaceState({
        lineageId: yield* Schema.decodeUnknownEffect(ArtifactLineageId)(id),
        expectedVersion: 0,
        value: {
          schema: "delta-pr-tracker/v1",
          me: { login: "visual" },
          history: [],
          warnings: [],
          ...rows,
        },
      });
    }).pipe(
      Effect.provide(
        makeArtifactStorageLive(join(paths.cakeHome, "state", "artifacts")).pipe(
          Layer.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)),
        ),
      ),
    ),
  );
}

const widgetFrame = (page: Page) =>
  page.locator('[data-slot="artifact-disclosure"]').first().locator("iframe").contentFrame();

export function createWidgetComposerAttachScenario(
  dependencies: Dependencies,
): VisualCaptureScenario {
  const frame = widgetFrame;
  return {
    name: "widget-composer-attach",
    description:
      "Delta PRs rows add PRs to the current chat composer as widget-item chips without sending",
    states: ["row", "attached", "preview"],
    async seed(paths, theme) {
      const now = new Date().toISOString();
      await seedDeltaPrs(dependencies, paths, theme, "widget-composer-attach", {
        refreshedAt: now,
        authored: prs.map(([number, prTitle, group, status]) => ({
          number,
          title: prTitle,
          group,
          status,
          updatedAt: now,
        })),
        reviewRequests: [],
      });
    },
    async prepare(page, state) {
      // The inline widget's default composer target is the chat it is shown in.
      await dependencies.openSession(page, "Cake architecture", "Explain how Cake");
      const widget = frame(page);
      const attach = (number: number) =>
        widget.getByRole("button", { name: `Add #${number} to chat composer` });
      // The sandboxed frame compiles and hydrates its saved state after the session opens.
      await expect(attach(prs[0][0])).toBeVisible({ timeout: 20_000 });
      if (state === "row") {
        await attach(prs[0][0]).hover();
        return;
      }
      await attach(prs[0][0]).click();
      await expect(
        page.getByRole("button", { name: `#${prs[0][0]} ${prs[0][1]} from ${title}` }),
      ).toBeVisible();
      await attach(prs[1][0]).click();
      const chip = page.getByRole("button", { name: `#${prs[1][0]} ${prs[1][1]} from ${title}` });
      await expect(chip).toBeVisible();
      await expect(page.getByRole("button", { name: /from Delta PRs$/ })).toHaveCount(2);
      if (state === "preview") {
        await chip.click();
        await expect(page.getByRole("dialog").getByText(/"number": 48107/)).toBeVisible();
      } else await page.mouse.move(1, 1);
    },
    region(page, state) {
      return state === "row"
        ? page.locator('[data-slot="artifact-disclosure"]').first()
        : state === "attached"
          ? page.locator(".workbench-composer").first()
          : page.locator('[data-slot="chat"]').first();
    },
  };
}

// Synthetic rows whose status text matches what the Delta PRs runtime writes for each group.
// Rows belong to the fixture's registered project (the chat in view), except #48141, which is in
// another project and hidden by the project scope.
function groupRows(now: number, projectPath: string) {
  const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
  const project = { path: projectPath, name: "Cake architecture" };
  const row = (
    number: number,
    prTitle: string,
    group: string,
    status: string,
    minutes: number,
    extra: JsonObject = {},
  ) => ({
    number,
    title: prTitle,
    group,
    status,
    updatedAt: ago(minutes),
    projects: [project],
    lanes: [group],
    fixKey: group === "blocked" ? `key-${number}` : null,
    ...extra,
  });
  return {
    refreshedAt: ago(4),
    // #48170 had /merge posted from the widget after the last pull: shown as Merging (requested).
    mergeOverrides: { "48170": { at: ago(1), pull: 1 } },
    // #48107 had Fix sent to its Project Chat 3 minutes ago: shown as fix requested.
    fixRequests: {
      "48107": {
        at: ago(3),
        until: new Date(now + 117 * 60_000).toISOString(),
        key: "key-48107",
        group: "blocked",
        project,
      },
    },
    authored: [
      row(
        48170,
        "Retire bot PRs main already made obsolete",
        "ready_to_merge",
        "Approved by aaron.casanova · Binks clear · CI not run",
        20,
      ),
      row(
        48160,
        "Say who commented at the top of rapid review",
        "merging",
        "Merging: waiting for CI · Approved by aaron.casanova · Binks clear · CI passed",
        6,
      ),
      row(
        48121,
        "Retry flaky checkout payment test with a fixed clock",
        "ready_to_merge",
        "Approved by aaron.casanova · Binks clear · CI passed",
        43,
      ),
      row(
        48133,
        "Review activity feed with optimistic actions",
        "blocked",
        "Blocked: Conflict, 4 unresolved threads · Merge stopped: Merge conflict (before the latest push) · Approved by aaron.casanova · Binks clear · CI passed",
        52,
        { blockedBy: ["Conflict"] },
      ),
      row(
        48140,
        "Recover reactive queries after network errors",
        "ci_pending",
        "Approved by carlos.corvaia, ryan.wilsonperkin · Binks reviewing · CI not run · Pending: restricted-merges check missing, reviews check missing",
        60 * 26,
      ),
      row(
        48141,
        "Send client overrides with Server Intent requests",
        "blocked",
        "Blocked: Conflict · Approved by matt.dentremont · Binks clear · CI passed",
        70,
        { blockedBy: ["Conflict"], projects: [{ path: "/visual/admin-web", name: "admin-web" }] },
      ),
      row(
        48107,
        "Cache shipping zone lookups per request",
        "blocked",
        "Blocked: Conflict (as of last pull), Failing: Required CI, 1 open Binks finding · Needs approval",
        95,
        // Unapproved and blocked: listed in Blocked and in Waiting on review.
        { lanes: ["blocked", "waiting_on_review"] },
      ),
      row(
        48093,
        "Plan and build each goal in its own pipeline",
        "waiting_on_review",
        "Needs approval (only Binks approved) · Binks clear · CI passed",
        130,
      ),
      row(
        48088,
        "Move tax rounding into the money value object",
        "waiting_on_review",
        "Changes requested by matt.dentremont · Binks clear · CI passed",
        60 * 5,
      ),
      row(
        48150,
        "Give the goal rubric a verification standard",
        "draft",
        "CI not run",
        60 * 24 * 5,
        { draft: true, ownership: "assigned", author: "River", authorBrand: "River" },
      ),
    ],
    reviewRequests: [
      row(
        48010,
        "Merge duplicated updateError returns in the form reducer",
        "waiting_on_my_review",
        "by Self-Healing Bot · requested from you",
        60 * 24 * 4,
      ),
    ],
  };
}

export function createDeltaPrsGroupsScenario(dependencies: Dependencies): VisualCaptureScenario {
  return {
    name: "delta-prs-groups",
    description:
      "Delta PRs lanes: Blocked (incl. an unapproved PR also in Waiting on review), CI pending, review waits, and River PRs assigned to you",
    states: [
      "groups",
      "lower",
      "row-rest",
      "row-hover",
      "row-focus",
      "merge-ready",
      "merge-requested",
      "merge-error",
      // Whole widget: Blocked shows a Fix at rest (#48133), a requested Fix (#48107) and Fix all.
      "fix-rest",
      "fix-error",
    ],
    async seed(paths, theme) {
      await seedDeltaPrs(
        dependencies,
        paths,
        theme,
        "delta-prs-groups",
        groupRows(Date.now(), paths.project),
      );
    },
    async prepare(page, state) {
      await dependencies.openSession(page, "Cake architecture", "Explain how Cake");
      const widget = widgetFrame(page);
      await expect(widget.getByRole("region", { name: "Blocked" })).toBeVisible({
        timeout: 20_000,
      });
      // "lower" scrolls to the Waiting on review, Draft (River PR) and review-request sections.
      if (state === "lower")
        await widget.getByRole("region", { name: "Waiting on my review" }).scrollIntoViewIfNeeded();
      await expect(widget.getByText("River", { exact: true })).toBeAttached();
      // Scoped to the chat's project: #48141 (admin-web) is hidden.
      await expect(widget.getByText("Cake architecture", { exact: true })).toBeVisible();
      await expect(widget.locator('a[data-pr="48141"]')).toHaveCount(0);
      await page.mouse.move(1, 1);
      const blocked = widget.locator("#sec-blocked");
      if (state.startsWith("fix-")) {
        await expect(
          blocked.getByRole("button", { name: "Fix all in Blocked: 1 PR" }),
        ).toBeVisible();
        await expect(blocked.getByText("fix requested", { exact: true })).toBeVisible();
      }
      // No backend runtime in the capture fixture: Fix fails like an unavailable chat, and the
      // row keeps its Fix button with the error. No Project Chat is ever messaged.
      if (state === "fix-error") {
        await blocked
          .getByRole("button", { name: "Fix #48133: ask the Cake architecture chat" })
          .click();
        await expect(blocked.getByRole("alert")).toContainText("Couldn't send Fix");
        await page.mouse.move(1, 1);
      }
      // Row states: the attach button is hidden at rest, shown on row hover and on keyboard focus.
      const attach = widget.getByRole("button", { name: "Add #48121 to chat composer" });
      if (state === "row-rest") await expect(attach).toHaveCSS("opacity", "0");
      if (state === "row-hover") {
        await widget.locator("#sec-ready_to_merge li").first().hover();
        await expect(attach).toHaveCSS("opacity", "1");
      }
      if (state === "row-focus") {
        await widget.locator('a[data-pr="48121"]').focus();
        await page.keyboard.press("Tab");
        await expect(
          widget.getByRole("button", { name: "Merge #48121: post /merge" }),
        ).toBeFocused();
        await page.keyboard.press("Tab");
        await expect(attach).toBeFocused();
        await expect(attach).toHaveCSS("opacity", "1");
      }
      // The capture fixture has no backend runtime, so clicking Merge fails like a refused post:
      // the row returns to Ready to merge with the error. Nothing is ever posted to Delta.
      if (state === "merge-error") {
        await widget.getByRole("button", { name: "Merge #48121: post /merge" }).click();
        await expect(widget.locator("#sec-ready_to_merge").getByRole("alert")).toContainText(
          "Couldn't post /merge",
        );
        await page.mouse.move(1, 1);
      }
    },
    region(page, state) {
      return state === "merge-requested"
        ? widgetFrame(page).locator("#sec-merging")
        : state.startsWith("row-") || state.startsWith("merge-")
          ? widgetFrame(page).locator("#sec-ready_to_merge")
          : page.locator('[data-slot="artifact-disclosure"]').first();
    },
  };
}
