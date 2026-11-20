import { makeSubagentStorageTestLayer } from "../helpers/subagentStorageFixture";
import { globalArtifactTestLayer } from "../helpers/globalArtifactTestLayer";
import { Effect, Layer } from "effect";
import type { ProjectSessionRuntimeIntegrations } from "../../../src/services/pi/ProjectSessionRuntimeHost";
import { ProjectSessionRuntimeHost } from "../../../src/services/pi/ProjectSessionRuntimeHost";
import { ProjectSessionConfiguration } from "../../../src/services/project-sessions/ProjectSessionConfiguration";
import { SessionCatalogChanges } from "../../../src/services/session-catalogs/SessionCatalogChanges";
import { SubagentCoordinatorLive } from "../../../src/services/subagents/SubagentCoordinator";
import { SubagentEnvironment } from "../../../src/services/subagents/SubagentEnvironment";
import { VsCodeServer } from "../../../src/services/vscode/VsCodeServer";
import { Terminal } from "../../../src/services/terminal/Terminal";
import { fakeManagedWorktrees } from "../../helpers/fakes/managedWorktrees";
import { fakePiModels } from "../../helpers/fakes/piModels";
import { fakeProjectAccess } from "../../helpers/fakes/projectAccess";
import { fakeRendererRequestCoordinator } from "../../helpers/fakes/rendererRequestCoordinator";
import { fakeSessionArchiveStorage } from "../../helpers/fakes/sessionArchiveStorage";
import { fakeSessionFamilyStorage } from "../../helpers/fakes/sessionFamilyStorage";
import { fakeTaskInputStorage } from "../../helpers/fakes/taskInputStorage";

const defaultIntegrations: ProjectSessionRuntimeIntegrations = {
  requestUi: async () => undefined,
  requestApplicationControl: async () => ({ ok: true }),
  emitExtensionUiIntent: () => undefined,
  persistArtifact: async () => {
    throw new Error("Unexpected artifact persistence");
  },
  requestInterview: async () => undefined,
  generateInlineWidget: async () => {
    throw new Error("Unexpected widget generation");
  },
};

export const makeHeadlessProjectSessionRuntimeMechanismTestLayer = (
  integrations: ProjectSessionRuntimeIntegrations = defaultIntegrations,
) =>
  Layer.mergeAll(
    globalArtifactTestLayer,
    fakeTaskInputStorage({ authorizeForward: () => Effect.succeed([]) }),
    Layer.succeed(ProjectSessionConfiguration, {
      agentDirectory: "/cake",
      sessionDirectory: "/cake/sessions",
      resolvedSessionDirectory: "/cake/resolved",
    }),
    fakeProjectAccess({
      rememberSessionLocation: () => Effect.void,
      isAllowed: () => Effect.succeed(true),
    }),
    Layer.mock(ProjectSessionRuntimeHost, {
      prepare: () =>
        Effect.succeed({ integrations, initialize: Effect.void, release: Effect.void }),
    }),
    fakePiModels(),
    fakeRendererRequestCoordinator({ presentAgentAction: () => Effect.void }),
    Layer.mock(Terminal, {
      closeWorkingDirectory: () => Effect.void,
    }),
    Layer.succeed(SubagentEnvironment, {
      location: (workingDirectory) =>
        Effect.succeed({
          workingDirectory: workingDirectory ?? "/home",
          agentDirectory: "/cake",
          sessionDirectory: "/cake/subagents",
        }),
    }),
    SubagentCoordinatorLive.pipe(Layer.provide(makeSubagentStorageTestLayer())),
  );

export const makeProjectSessionRuntimeMechanismTestLayer = (
  integrations: ProjectSessionRuntimeIntegrations = defaultIntegrations,
) =>
  Layer.mergeAll(
    makeHeadlessProjectSessionRuntimeMechanismTestLayer(integrations),
    Layer.mock(VsCodeServer, {
      runProjectScript: (_workingDirectory, _source, input) =>
        Effect.succeed({ status: "completed" as const, value: input }),
      leaseFor: () => undefined,
    }),
  );

export const makeProjectSessionRuntimeTestLayer = (
  integrations: ProjectSessionRuntimeIntegrations = defaultIntegrations,
) =>
  Layer.mergeAll(
    makeProjectSessionRuntimeMechanismTestLayer(integrations),
    SessionCatalogChanges.layer,
    fakeSessionArchiveStorage({ locate: () => Effect.succeed("active" as const) }),
    fakeSessionFamilyStorage(),
    fakeManagedWorktrees(),
  );
