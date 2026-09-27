import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Effect, Layer, Stream } from "effect";
import { acquireOptions } from "../../../src/domain/project-sessions/projectSessionRuntime";
import { defaultApplicationState } from "../../../src/domain/application/application-data";
import {
  makeCakeSessionRuntimesLayer,
  type CakeSessionRuntimesAdapter,
} from "../../../src/services/pi/CakeSessionRuntimes";
import { ApplicationState } from "../../../src/services/storage/ApplicationState";
import { SessionArchiveStorage } from "../../../src/services/storage/SessionArchiveStorage";
import { SessionFamilyStorage } from "../../../src/services/storage/SessionFamilyStorage";
import { ManagedWorktrees } from "../../../src/services/worktrees/ManagedWorktrees";
import { SessionCatalogChanges } from "../../../src/services/session-catalogs/SessionCatalogChanges";
import { makeHeadlessProjectSessionRuntimeMechanismTestLayer } from "./projectSessionRuntimeTestLayer";
import { fakeRuntime } from "../helpers/piRuntimeFixture";

it.effect("creates independent Pi-backed Project Session without any renderer", () => {
  const prompts: string[] = [];
  let reportPrompt: () => void = () => undefined;
  const promptCalled = new Promise<void>((resolve) => {
    reportPrompt = resolve;
  });
  const adapter: CakeSessionRuntimesAdapter = {
    createRuntime: (options) =>
      Effect.succeed({
        ...fakeRuntime(options, () => undefined),
        sessionId: options.sessionId ?? "unexpected-session",
        prompt: async (text) => {
          prompts.push(text);
          reportPrompt();
        },
      }),
    sessionIds: () => Stream.empty,
    catalog: () => Stream.empty,
    catalogEntry: () => Effect.succeed(undefined),
    inspect: () => Effect.succeed(undefined),
    changelog: () => Effect.succeed(""),
  };
  const dependencies = Layer.mergeAll(
    makeHeadlessProjectSessionRuntimeMechanismTestLayer({
      requestUi: async () => undefined,
      requestApplicationControl: async () => {
        throw new Error("Renderer must not create a session");
      },
      emitExtensionUiIntent: () => undefined,
      persistArtifact: async () => {
        throw new Error("Unexpected artifact persistence");
      },
      requestArtifact: async () => undefined,
      generateInlineWidget: async () => {
        throw new Error("Unexpected widget generation");
      },
    }),
    makeCakeSessionRuntimesLayer(adapter),
    SessionCatalogChanges.layer,
    Layer.mock(ApplicationState, {
      snapshot: () => ({
        ...defaultApplicationState(),
        projects: [
          { path: "/project", name: "Project", addedAt: "2026-01-01", lastOpenedAt: "2026-01-01" },
        ],
      }),
    }),
    Layer.mock(SessionFamilyStorage, {
      familyForMember: () => Effect.succeed(undefined),
      withMemberLock: (_sessionId, effect) => effect,
      settleTurn: () => Effect.void,
    }),
    Layer.mock(SessionArchiveStorage, { locate: () => Effect.succeed("active" as const) }),
    Layer.mock(ManagedWorktrees, {
      records: () => Effect.succeed([]),
      awaitSetup: () => Effect.void,
    }),
  );
  return Effect.gen(function* () {
    const options = yield* acquireOptions({
      sessionId: "source",
      newSession: false,
      location: {
        projectPath: "/project",
        projectName: "Project",
        workingDirectory: "/project",
        sessionDirectory: "/cake/sessions",
        resolvedSessionDirectory: "/cake/resolved",
      },
    });
    const control = options.runtime.currentSessionControl?.createSession;
    assert.ok(control);
    const result = yield* Effect.promise(() =>
      control(
        {
          name: "Headless",
          initialPrompt: "Start exactly one real turn",
          model: { provider: "openai", modelId: "model", thinkingLevel: "high", fastMode: false },
        },
        new AbortController().signal,
      ),
    );
    assert.equal((result as { ok: boolean }).ok, true);
    yield* Effect.promise(() => promptCalled);
    assert.deepEqual(prompts, ["Start exactly one real turn"]);
  }).pipe(Effect.provide(dependencies));
});
