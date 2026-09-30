import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Effect, Layer, Schema, Stream } from "effect";
import { expect, vi } from "vitest";
import { acquireOptions } from "../../../src/domain/project-sessions/projectSessionRuntime";
import { defaultApplicationState } from "../../../src/domain/application/application-data";
import { makeCakeSessionRuntimesLayer } from "../../../src/services/pi/CakeSessionRuntimes";
import { PiModels } from "../../../src/services/pi/PiModels";
import { ApplicationState } from "../../../src/services/storage/ApplicationState";
import { SessionArchiveStorage } from "../../../src/services/storage/SessionArchiveStorage";
import { ManagedWorktrees } from "../../../src/services/worktrees/ManagedWorktrees";
import { SessionCatalogChanges } from "../../../src/services/session-catalogs/SessionCatalogChanges";
import { makeHeadlessProjectSessionRuntimeMechanismTestLayer } from "./projectSessionRuntimeTestLayer";
import { familyStorageHarness } from "../helpers/familyStorageHarness";
import { fakeRuntime } from "../helpers/piRuntimeFixture";

it.effect.each([
  { placement: "none" as const, launchFails: false, rendererUnavailable: false },
  { placement: "right" as const, launchFails: false, rendererUnavailable: false },
  { placement: "down" as const, launchFails: false, rendererUnavailable: false },
  { placement: "none" as const, launchFails: true, rendererUnavailable: false },
  { placement: "none" as const, launchFails: false, rendererUnavailable: true },
])("projects child activity independently of pane placement (%j)", (scenario) => {
  const requestApplicationControl = vi.fn(async () => {
    if (scenario.rendererUnavailable) throw new Error("No renderer connected");
    return { ok: true };
  });
  const dependencies = Layer.mergeAll(
    makeHeadlessProjectSessionRuntimeMechanismTestLayer({
      requestUi: async () => undefined,
      requestApplicationControl,
      emitExtensionUiIntent: () => undefined,
      persistArtifact: async () => {
        throw new Error("Unexpected artifact persistence");
      },
      requestArtifact: async () => undefined,
      generateInlineWidget: async () => {
        throw new Error("Unexpected widget generation");
      },
    }),
    makeCakeSessionRuntimesLayer({
      createRuntime: (options) =>
        scenario.launchFails
          ? Effect.fail(new Error("Cannot acquire child runtime"))
          : Effect.succeed({
              ...fakeRuntime(options, () => undefined),
              sessionId: options.sessionId ?? "unexpected-session",
            }),
      sessionIds: () => Stream.empty,
      catalog: () => Stream.empty,
      catalogEntry: () => Effect.succeed(undefined),
      inspect: () => Effect.succeed(undefined),
      changelog: () => Effect.succeed(""),
    }),
    SessionCatalogChanges.layer,
    familyStorageHarness().layer,
    Layer.mock(PiModels, { resolve: (selection) => Effect.succeed(selection) }),
    Layer.mock(ApplicationState, { snapshot: () => defaultApplicationState() }),
    Layer.mock(SessionArchiveStorage, { locate: () => Effect.succeed(undefined) }),
    Layer.mock(ManagedWorktrees, {
      records: () => Effect.succeed([]),
      awaitSetup: () => Effect.void,
    }),
  );
  return Effect.gen(function* () {
    const options = yield* acquireOptions({
      sessionId: "parent",
      newSession: false,
      location: {
        projectPath: "/project",
        projectName: "Project",
        workingDirectory: "/project",
        sessionDirectory: "/cake/sessions",
        resolvedSessionDirectory: "/cake/resolved",
      },
    });
    const createChild = options.runtime.currentSessionControl?.createChildSession;
    assert.ok(createChild);
    const rawResult = yield* Effect.promise(() =>
      createChild(
        {
          requestId: "create-background-child",
          title: "Background worker",
          initialPrompt: "Work without being selected",
          model: { provider: "test", modelId: "test", thinkingLevel: "off", fastMode: false },
          placement: scenario.placement,
          senderContext: { usedTokens: 1000, windowTokens: 128000 },
        },
        new AbortController().signal,
      ),
    );
    const result = yield* Schema.decodeUnknownEffect(
      Schema.Struct({
        childSessionId: Schema.String,
        familyId: Schema.String,
        launch: Schema.Struct({ status: Schema.String }),
      }),
    )(rawResult);
    expect(result.launch).toMatchObject({ status: scenario.launchFails ? "failed" : "accepted" });
    if (scenario.launchFails) {
      expect(requestApplicationControl).not.toHaveBeenCalled();
    } else {
      expect(requestApplicationControl).toHaveBeenCalledExactlyOnceWith(
        {
          _tag: "ProjectChildSession",
          childSessionId: result.childSessionId,
          title: "Background worker",
          familyId: result.familyId,
          familyChildOrder: 0,
          familyDepth: 1,
          workingDirectory: "/project",
          placement: scenario.placement,
        },
        expect.any(AbortSignal),
      );
    }
  }).pipe(Effect.provide(dependencies));
});
