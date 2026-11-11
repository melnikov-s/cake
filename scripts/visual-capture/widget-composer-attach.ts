import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { NodeFileSystem, NodePath } from "@effect/platform-node-shared";
import { expect, type Page } from "@playwright/test";
import { Effect, Layer, Schema } from "effect";
import type { CakeArtifactV1 } from "../../src/contracts/artifacts/artifact-contract";
import { ArtifactLineageId } from "../../src/contracts/artifacts/artifact-lineage";
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

export function createWidgetComposerAttachScenario(dependencies: {
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
}): VisualCaptureScenario {
  const frame = (page: Parameters<VisualCaptureScenario["prepare"]>[0]) =>
    page.locator('[data-slot="artifact-disclosure"]').first().locator("iframe").contentFrame();
  return {
    name: "widget-composer-attach",
    description:
      "Delta PRs rows add PRs to the current chat composer as widget-item chips without sending",
    states: ["row", "attached", "preview"],
    async seed(paths, theme) {
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
          sessionId: "widget-composer-attach",
          revision: 1,
          kind: "widget",
          title,
          payload: {
            language: "html",
            source,
            brief: "Delta PRs dashboard with per-row composer attach",
            generationSessionId: "widget-composer-attach-fixture",
            browser: await dependencies.retainBrowser(paths, "html", source),
          },
          fallback: { markdown: title },
          interaction: { mode: "present" },
        },
        true,
      );
      const now = new Date().toISOString();
      await Effect.runPromise(
        Effect.gen(function* () {
          const storage = yield* ArtifactStorage;
          yield* storage.replaceState({
            lineageId: yield* Schema.decodeUnknownEffect(ArtifactLineageId)(id),
            expectedVersion: 0,
            value: {
              schema: "delta-pr-tracker/v1",
              me: { login: "visual" },
              refreshedAt: now,
              authored: prs.map(([number, prTitle, group, status]) => ({
                number,
                title: prTitle,
                group,
                status,
                updatedAt: now,
              })),
              reviewRequests: [],
              history: [],
              warnings: [],
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
