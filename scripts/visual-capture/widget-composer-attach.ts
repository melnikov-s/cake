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
  [
    48107,
    "Cache shipping zone lookups per request",
    "binks_comments",
    "3 unresolved Binks comments",
  ],
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
  rows: { authored: JsonObject[]; reviewRequests: JsonObject[]; refreshedAt: string },
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
function groupRows(now: number) {
  const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
  const row = (
    number: number,
    prTitle: string,
    group: string,
    status: string,
    minutes: number,
    extra: JsonObject = {},
  ) => ({ number, title: prTitle, group, status, updatedAt: ago(minutes), ...extra });
  return {
    refreshedAt: ago(4),
    authored: [
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
        "Blocked: Conflict · Merge stopped: Merge conflict · Approved by aaron.casanova · Binks clear · CI passed · 4 unresolved threads",
        52,
        { blockedBy: ["Conflict"] },
      ),
      row(
        48140,
        "Recover reactive queries after network errors",
        "blocked",
        "Blocked: restricted-merges check missing, reviews check missing · Approved by carlos.corvaia, ryan.wilsonperkin · Binks clear · CI not run",
        60 * 26,
        { blockedBy: ["restricted-merges check missing", "reviews check missing"] },
      ),
      row(
        48107,
        "Cache shipping zone lookups per request",
        "binks_comments",
        "1 open Binks finding · Needs approval · CI not run",
        95,
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
      "Delta PRs groups: human-approved PRs that are still blocked, review waits, and River PRs assigned to you",
    states: ["groups", "lower", "row-rest", "row-hover", "row-focus"],
    async seed(paths, theme) {
      await seedDeltaPrs(dependencies, paths, theme, "delta-prs-groups", groupRows(Date.now()));
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
      await page.mouse.move(1, 1);
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
        await expect(attach).toBeFocused();
        await expect(attach).toHaveCSS("opacity", "1");
      }
    },
    region(page, state) {
      return state.startsWith("row-")
        ? widgetFrame(page).locator("#sec-ready_to_merge")
        : page.locator('[data-slot="artifact-disclosure"]').first();
    },
  };
}
