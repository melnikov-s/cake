import assert from "node:assert/strict";
import { WorkflowTestLive } from "../helpers/workflowFixture";
import { it } from "@effect/vitest";
import { Effect, Layer, Stream } from "effect";
import { acquireOptions } from "../../../src/domain/project-sessions/projectSessionRuntime";
import { projectTodoLayer } from "../helpers/projectTodoHarness";
import * as projectTodos from "../../../src/domain/projects/projectTodos";
import {
  makeCakeSessionRuntimesLayer,
  type CakeSessionRuntimesAdapter,
} from "../../../src/services/pi/CakeSessionRuntimes";
import { SessionArchiveStorage } from "../../../src/services/storage/SessionArchiveStorage";
import { SessionFamilyStorage } from "../../../src/services/storage/SessionFamilyStorage";
import { ManagedWorktrees } from "../../../src/services/worktrees/ManagedWorktrees";
import { SessionCatalogChanges } from "../../../src/services/session-catalogs/SessionCatalogChanges";
import { makeHeadlessProjectSessionRuntimeMechanismTestLayer } from "./projectSessionRuntimeTestLayer";
import { makeRuntimeRecoveryStorageTestLayer, fakeRuntime } from "../helpers/piRuntimeFixture";

it.effect("creates independent Pi-backed Project Session without any renderer", () => {
  const prompts: string[] = [];
  const initialPrompt =
    "Start exactly one real turn. Keep the original prompt intact.\n\n" +
    "Detailed implementation instructions for Pi only. ".repeat(80);
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
    WorkflowTestLive,
    makeHeadlessProjectSessionRuntimeMechanismTestLayer({
      requestUi: async () => undefined,
      requestApplicationControl: async () => {
        throw new Error("Renderer must not create a session");
      },
      emitExtensionUiIntent: () => undefined,
      persistArtifact: async () => {
        throw new Error("Unexpected artifact persistence");
      },
      requestInterview: async () => undefined,
      generateInlineWidget: async () => {
        throw new Error("Unexpected widget generation");
      },
    }),
    makeCakeSessionRuntimesLayer(adapter).pipe(
      Layer.provide(makeRuntimeRecoveryStorageTestLayer()),
    ),
    SessionCatalogChanges.layer,
    projectTodoLayer(),
    Layer.mock(SessionFamilyStorage, {
      familyForMember: () => Effect.succeed(undefined),
      withMemberLock: (_sessionId, effect) => effect,
      state: () => Effect.succeed({ families: [], turns: [], spawnedSessions: [] }),
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
          initialPrompt,
          model: { provider: "openai", modelId: "model", thinkingLevel: "high", fastMode: false },
        },
        new AbortController().signal,
      ),
    );
    assert.equal((result as { ok: boolean }).ok, true);
    yield* Effect.promise(() => promptCalled);
    assert.deepEqual(prompts, [initialPrompt]);
    const items = (yield* projectTodos.list("/project")).items;
    assert.equal(items.length, 1);
    assert.equal(
      items[0]?.description,
      "Start exactly one real turn. Keep the original prompt intact.",
    );
  }).pipe(Effect.provide(dependencies));
});
