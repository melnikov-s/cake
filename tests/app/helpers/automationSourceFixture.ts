import { AgentControlTestLive } from "./agentControlTestLayer";
import { Effect, Layer, Stream } from "effect";
import type { AutomationSourceEvent } from "../../../src/contracts/automations/automation-data";
import { AutomationEvents } from "../../../src/services/automations/AutomationEvents";
import { acquireOptions } from "../../../src/domain/project-sessions/projectSessionRuntime";
import { makeCakeSessionRuntimesLayer } from "../../../src/services/pi/CakeSessionRuntimes";
import { SessionCatalogChanges } from "../../../src/services/session-catalogs/SessionCatalogChanges";
import { makeHeadlessProjectSessionRuntimeMechanismTestLayer } from "../domain/projectSessionRuntimeTestLayer";
import { projectTodoLayer } from "./projectTodoHarness";
import { familyStorageHarness } from "./familyStorageHarness";
import { fakeRuntime, makeRuntimeRecoveryStorageTestLayer } from "./piRuntimeFixture";
import { fakeManagedWorktrees } from "../../helpers/fakes/managedWorktrees";
import { fakeSessionArchiveStorage } from "../../helpers/fakes/sessionArchiveStorage";

export const automationSourceFixture = Effect.fn("AutomationSourceFixture.make")(function* () {
  const events: AutomationSourceEvent[] = [];
  const dependencies = Layer.mergeAll(
    AgentControlTestLive,
    makeHeadlessProjectSessionRuntimeMechanismTestLayer({
      requestUi: async () => undefined,
      requestApplicationControl: async () => ({ ok: true }),
      emitExtensionUiIntent: () => undefined,
      requestInterview: async () => undefined,
      persistArtifact: async () => {
        throw new Error("Unexpected artifact publication");
      },
      generateInlineWidget: async () => {
        throw new Error("Unexpected widget generation");
      },
    }),
    makeCakeSessionRuntimesLayer({
      createRuntime: (options) => Effect.succeed(fakeRuntime(options, () => undefined)),
      sessionIds: () => Stream.empty,
      catalog: () => Stream.empty,
      catalogEntry: () => Effect.succeed(undefined),
      inspect: () => Effect.succeed(undefined),
      changelog: () => Effect.succeed(""),
    }).pipe(Layer.provide(makeRuntimeRecoveryStorageTestLayer())),
    SessionCatalogChanges.layer,
    familyStorageHarness().layer,
    projectTodoLayer(),
    fakeSessionArchiveStorage({ locate: () => Effect.succeed("active" as const) }),
    fakeManagedWorktrees({
      records: () => Effect.succeed([]),
      awaitSetup: () => Effect.void,
    }),
    Layer.succeed(AutomationEvents, {
      publish: (event) =>
        Effect.sync(() => {
          events.push(event);
        }),
      events: () => Stream.empty,
    }),
  );
  const context = yield* Layer.build(dependencies);
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
  }).pipe(Effect.provide(context));
  return { context, options, events };
});
