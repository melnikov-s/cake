import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeFileSystem, NodePath } from "@effect/platform-node-shared";
import { Context, Effect, Layer } from "effect";
import { expect, it, vi } from "vitest";
import { findVisualCaptureScenario } from "../../scripts/visual-capture/scenarios";
import {
  artifactRevisionToRecord,
  decodeArtifactLineageId,
} from "../../src/contracts/artifacts/artifact-lineage";
import { generateReviewedWidget } from "../../src/domain/widgets/widgetGenerationReview";
import { createProjectSessionRuntime } from "../../src/layers/CakeOperations";
import { ProjectSessionIntegrationHost } from "../../src/layers/ProjectSessionIntegrationHost";
import { ArtifactStorage } from "../../src/services/storage/ArtifactStorage";
import { makeArtifactStorageLive } from "../../src/services/storage/ArtifactStorageLive";
import { WidgetBrowserOutputs } from "../../src/services/widgets/WidgetBrowserOutputs";
import { makeWidgetBrowserOutputsLive } from "../../src/services/widgets/WidgetBrowserOutputsLive";

it("runs /cake-artifacts without a provider and retains executable browser output for reopening", async () => {
  const root = await mkdtemp(join(tmpdir(), "cake-artifact-diagnostic-"));
  const agentDir = join(root, "agent");
  const browserLayer = makeWidgetBrowserOutputsLive(join(root, "browser-outputs"));
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  try {
    await mkdir(agentDir);
    await Effect.runPromise(
      Effect.gen(function* () {
        const storageContext = yield* Layer.build(
          makeArtifactStorageLive(join(root, "artifacts")).pipe(
            Layer.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer)),
          ),
        );
        const storage = Context.get(storageContext, ArtifactStorage);
        const providerWork = vi.fn(async () => {
          throw new Error("Diagnostics must not invoke model generation or review");
        });
        const host = new ProjectSessionIntegrationHost({
          workspacePath: root,
          agentDir,
          sessionDir: join(root, "sessions"),
          emit: () => undefined,
          requestUi: async () => undefined,
          requestInterview: async () => undefined,
          requestApplicationControl: async () => null,
          execute: (effect) => Effect.runPromise(effect),
          runReviewedWidget: generateReviewedWidget,
          runWidgetGeneration: providerWork,
          runWidgetRepair: providerWork,
          runWidgetVisualReview: providerWork,
          retainWidgetBrowser: (compiled) =>
            Effect.runPromise(
              Effect.flatMap(WidgetBrowserOutputs, (outputs) => outputs.retain(compiled)).pipe(
                Effect.provide(browserLayer),
              ),
            ),
        });
        const runtime = yield* Effect.acquireRelease(
          Effect.promise(() =>
            createProjectSessionRuntime({
              ...host.runtimeIntegrations("diagnostic-session"),
              cwd: root,
              agentDir,
              sessionDir: join(root, "sessions"),
              sessionId: "diagnostic-session",
              newSession: true,
              trusted: true,
              onEvent: () => undefined,
              persistArtifact: (artifact) => {
                const input = {
                  lineageId: decodeArtifactLineageId(artifact.id),
                  expectedLatestRevision: artifact.revision - 1,
                  snapshot: artifact,
                  workingDirectory: root,
                };
                const publish =
                  artifact.revision === 1
                    ? storage.publishWithLink(input, {
                        lineageId: input.lineageId,
                        target: { type: "session", sessionId: artifact.sessionId },
                        selection: { mode: "follow-latest" },
                        createdAt: new Date(0).toISOString(),
                      })
                    : storage.publish(input);
                return Effect.runPromise(publish.pipe(Effect.map(artifactRevisionToRecord)));
              },
            }),
          ),
          (runtime) =>
            Effect.promise(async () => {
              await runtime.dispose();
              host[Symbol.dispose]();
            }),
        );
        yield* Effect.promise(() => runtime.prompt("/cake-artifacts", "prompt", []));
        expect(providerWork).not.toHaveBeenCalled();
        const [published] = yield* storage.listRevisions(decodeArtifactLineageId("cake-s4-widget"));
        expect(published?.snapshot.kind).toBe("widget");
        if (published?.snapshot.kind !== "widget")
          throw new Error("Diagnostic widget was not persisted");
        const browser = published.snapshot.payload.browser;
        const reopened = yield* Effect.flatMap(WidgetBrowserOutputs, (outputs) =>
          outputs.open(browser),
        ).pipe(Effect.provide(browserLayer));
        expect(reopened.document).toContain("<strong>Repairable widget</strong>");
        expect(reopened.document).toContain("__cakeArtifactBridge");
        expect(reopened.document).toContain(reopened.token);
        expect((yield* storage.catalog()).lineages).toHaveLength(4);
      }).pipe(Effect.scoped),
    );
  } finally {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

it.each(["inline-artifact", "cake-request-explanation"])(
  "seeds %s with retained executable browser files",
  async (name) => {
    const root = await mkdtemp(join(tmpdir(), "cake-widget-visual-fixture-"));
    const paths = {
      cakeHome: join(root, "cake"),
      project: join(root, "project"),
      userData: join(root, "user-data"),
    };
    try {
      const scenario = findVisualCaptureScenario(name);
      if (!scenario) throw new Error(`Missing visual scenario: ${name}`);
      await scenario.seed(paths, "light");
      const artifactRoot = join(paths.cakeHome, "state", "artifacts");
      await Effect.runPromise(
        Effect.gen(function* () {
          const storage = yield* ArtifactStorage;
          const { lineages } = yield* storage.catalog();
          expect(lineages).toHaveLength(1);
          const lineage = lineages[0];
          if (!lineage) throw new Error("Visual fixture has no artifact");
          const revision = yield* storage.read(lineage.id, lineage.latestRevision);
          if (revision?.snapshot.kind !== "widget")
            throw new Error("Visual fixture is not a widget");
          const outputs = yield* WidgetBrowserOutputs;
          const compiled = yield* outputs.open(revision.snapshot.payload.browser);
          expect(compiled.document).toContain('<div id="cake-widget-root">');
          expect(compiled.document).toContain("__cakeArtifactBridge");
          expect(compiled.document).toContain(compiled.token);
          expect(compiled.document).toContain(
            name === "inline-artifact" ? "One artifact, two views" : "The conversation crosses.",
          );
        }).pipe(
          Effect.provide(
            Layer.merge(
              makeArtifactStorageLive(artifactRoot).pipe(
                Layer.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer)),
              ),
              makeWidgetBrowserOutputsLive(join(artifactRoot, "browser-outputs")),
            ),
          ),
        ),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
