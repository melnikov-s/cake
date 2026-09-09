import { Effect, Layer } from "effect";
import { Electron } from "../../../src/services/electron/Electron";
import { PiModels } from "../../../src/services/pi/PiModels";
import type { ProjectSessionRuntimeIntegrations } from "../../../src/services/pi/ProjectSessionIntegrationHost";
import { ProjectSessionRuntimeHost } from "../../../src/services/pi/ProjectSessionRuntimeHost";
import { ProjectAccess } from "../../../src/services/projects/ProjectAccess";
import { ProjectSessionConfiguration } from "../../../src/services/project-sessions/ProjectSessionConfiguration";
import { SessionCatalogChanges } from "../../../src/services/session-catalogs/SessionCatalogChanges";
import { SessionArchiveStorage } from "../../../src/services/storage/SessionArchiveStorage";
import { SessionFamilyStorage } from "../../../src/services/storage/SessionFamilyStorage";
import { SubagentCoordinatorLive } from "../../../src/services/subagents/SubagentCoordinator";
import { SubagentEnvironment } from "../../../src/services/subagents/SubagentEnvironment";
import { VsCodeServer } from "../../../src/services/vscode/VsCodeServer";
import { ManagedWorktrees } from "../../../src/services/worktrees/ManagedWorktrees";
import { Terminal } from "../../../src/services/terminal/Terminal";

const defaultIntegrations: ProjectSessionRuntimeIntegrations = {
  requestUi: async () => undefined,
  requestApplicationControl: async () => ({ ok: true }),
  emitExtensionUiIntent: () => undefined,
  persistArtifact: async () => {
    throw new Error("Unexpected artifact persistence");
  },
  requestArtifact: async () => undefined,
  generateInlineWidget: async () => {
    throw new Error("Unexpected widget generation");
  },
  listArtifacts: async () => [],
};

export const makeProjectSessionRuntimeMechanismTestLayer = (
  integrations: ProjectSessionRuntimeIntegrations = defaultIntegrations,
) =>
  Layer.mergeAll(
    Layer.succeed(ProjectSessionConfiguration, {
      agentDirectory: "/cake",
      sessionDirectory: "/cake/sessions",
      resolvedSessionDirectory: "/cake/resolved",
    }),
    Layer.mock(ProjectAccess, {
      rememberSessionLocation: () => Effect.void,
      isAllowed: () => Effect.succeed(true),
    }),
    Layer.mock(ProjectSessionRuntimeHost, {
      runtimeIntegrations: () => Effect.succeed(integrations),
      releaseSession: () => Effect.void,
    }),
    Layer.mock(PiModels, {}),
    Layer.mock(Electron, {
      openExternal: () => Effect.void,
      sendTo: () => undefined,
      broadcast: () => undefined,
      requireRendererConnection: () => {
        throw new Error("Unexpected renderer connection");
      },
      workspaceForConnection: () => undefined,
      associateWorkspace: () => undefined,
      forgetWorkspace: () => undefined,
      windowsForWorkspace: () => [],
      centerTrafficLights: () => undefined,
    }),
    Layer.mock(Terminal, {
      closeWorkingDirectory: () => Effect.void,
    }),
    Layer.mock(VsCodeServer, {
      enterProjectEditor: () => Effect.void,
      openProjectLocation: (_workingDirectory, location) =>
        Effect.succeed({ status: "completed" as const, value: location }),
      runProjectScript: (_workingDirectory, _source, input) =>
        Effect.succeed({ status: "completed" as const, value: input }),
      backToAgentForWindow: () => false,
    }),
    Layer.mock(SubagentEnvironment, {
      location: (workingDirectory) =>
        Effect.succeed({
          workingDirectory,
          agentDirectory: "/cake",
          sessionDirectory: "/cake/subagents",
          trusted: true,
        }),
    }),
    SubagentCoordinatorLive,
  );

export const makeProjectSessionRuntimeTestLayer = (
  integrations: ProjectSessionRuntimeIntegrations = defaultIntegrations,
) =>
  Layer.mergeAll(
    makeProjectSessionRuntimeMechanismTestLayer(integrations),
    SessionCatalogChanges.layer,
    Layer.mock(SessionArchiveStorage, {
      locate: () => Effect.succeed("active" as const),
    }),
    Layer.mock(SessionFamilyStorage, {
      familyForMember: () => Effect.succeed(undefined),
      settleTurn: () => Effect.void,
    }),
    Layer.mock(ManagedWorktrees, {
      records: () => Effect.succeed([]),
      proposeSquashMessage: () => Effect.void,
    }),
  );
