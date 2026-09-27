import { ClientConnectionsLive } from "../../../src/services/clients/ClientConnections";
import { DesktopHost } from "../../../src/services/electron/DesktopHost";
import { DesktopSharing } from "../../../src/services/electron/DesktopSharing";
import { Dictation } from "../../../src/services/dictation/Dictation";
import { Effect, Layer } from "effect";
import { AgentAvailability } from "../../../src/services/pi/AgentAvailability";
import { RendererRequestCoordinator } from "../../../src/services/renderer-requests/RendererRequestCoordinator";
import { ArtifactStorage } from "../../../src/services/storage/ArtifactStorage";
import { SavedDraftStorage } from "../../../src/services/storage/SavedDraftStorage";
import { SessionFamilyStorage } from "../../../src/services/storage/SessionFamilyStorage";
import { ArtifactProjection } from "../../../src/services/artifacts/ArtifactProjection";
import { Browser } from "../../../src/services/browser/Browser";
import { SessionCatalogChanges } from "../../../src/services/session-catalogs/SessionCatalogChanges";
import { CakeSessionRuntimes } from "../../../src/services/pi/CakeSessionRuntimes";
import { SessionArchiveStorage } from "../../../src/services/storage/SessionArchiveStorage";
import { SubagentCoordinatorLive } from "../../../src/services/subagents/SubagentCoordinator";
import { SubagentEnvironment } from "../../../src/services/subagents/SubagentEnvironment";
import { ProjectSessionConfiguration } from "../../../src/services/project-sessions/ProjectSessionConfiguration";
import { ManagedWorktrees } from "../../../src/services/worktrees/ManagedWorktrees";
import { Electron } from "../../../src/services/electron/Electron";
import { ProjectSessionRuntimeHost } from "../../../src/services/pi/ProjectSessionRuntimeHost";
import { VsCodeServer } from "../../../src/services/vscode/VsCodeServer";
import { VsCodeViews } from "../../../src/services/vscode/VsCodeViews";
import { PiModels } from "../../../src/services/pi/PiModels";
import { Terminal } from "../../../src/services/terminal/Terminal";
import { ReviewStorage } from "../../../src/services/storage/ReviewStorage";
import { DiscussionSessionEnvironment } from "../../../src/services/discussion-sessions/DiscussionSessionEnvironment";
import { DrawBoardStorage } from "../../../src/services/storage/DrawBoardStorage";
import { WindowStateStorage } from "../../../src/services/storage/WindowStateStorage";
import { InlineWidgets } from "../../../src/services/widgets/InlineWidgets";
import { WorktreeLandingCoordinatorLive } from "../../../src/services/worktrees/WorktreeLandingCoordinator";
import { WorktreeLandingCompletion } from "../../../src/services/worktrees/WorktreeLandingCompletion";
import { WorktreeLandingAgent } from "../../../src/services/worktrees/WorktreeLandingAgent";
import { PiSettings } from "../../../src/services/pi/PiSettings";
import { ScheduledMessages } from "../../../src/services/scheduled-messages/ScheduledMessages";
import { WorkspaceFiles } from "../../../src/services/filesystem/WorkspaceFiles";
import { NativeAttachments } from "../../../src/services/filesystem/NativeAttachments";
import { AttachmentUploads } from "../../../src/services/filesystem/AttachmentUploads";
import { ProjectConfiguration } from "../../../src/services/projects/ProjectConfiguration";
import { RewordingRequests } from "../../../src/services/projects/RewordingRequests";
import { PiAgentResources } from "../../../src/services/pi/PiAgentResources";
import { ArtifactGarbageCollector } from "../../../src/services/artifacts/ArtifactGarbageCollector";

const unexpectedCapability = (): never => {
  throw new Error("Unrelated endpoint capability invoked");
};

// Build the complete production endpoint, not a test-only RPC group. These unrelated external
// capabilities fail if called; the tests supply real ApplicationState/ClientEvents authorities.
export const unusedEndpointServices = Layer.mergeAll(
  ClientConnectionsLive,
  Layer.mock(DesktopHost, { current: () => ({ kind: "local" }) }),
  Layer.mock(DesktopSharing, { keepsProcessAlive: () => false }),
  Layer.mock(Dictation, {}),
  Layer.mock(AgentAvailability, {}),
  Layer.mock(RendererRequestCoordinator, {}),
  Layer.mock(ArtifactStorage, {}),
  Layer.mock(SavedDraftStorage, {}),
  Layer.mock(SessionFamilyStorage, {}),
  Layer.mock(ArtifactProjection, {}),
  Layer.mock(Browser, {}),
  Layer.mock(SessionCatalogChanges, {}),
  Layer.mock(CakeSessionRuntimes, {}),
  Layer.mock(SessionArchiveStorage, {}),
  SubagentCoordinatorLive,
  Layer.mock(SubagentEnvironment, {}),
  Layer.succeed(ProjectSessionConfiguration, {
    agentDirectory: "/agent",
    sessionDirectory: "/sessions",
    resolvedSessionDirectory: "/resolved",
  }),
  Layer.mock(ManagedWorktrees, {}),
  Layer.mock(Electron, {
    requireRendererConnection: unexpectedCapability,
    windowsForWorkspace: unexpectedCapability,
    centerTrafficLights: unexpectedCapability,
  }),
  Layer.mock(ProjectSessionRuntimeHost, {}),
  Layer.mock(VsCodeServer, {
    leaseFor: unexpectedCapability,
    releaseConnection: () => Effect.void,
  }),
  Layer.mock(VsCodeViews, { backToAgentForWindow: unexpectedCapability }),
  Layer.mock(PiModels, {}),
  Layer.mock(Terminal, {}),
  Layer.mock(ReviewStorage, {
    agentSessionDirectory: unexpectedCapability,
    reviewContextPath: unexpectedCapability,
    discussionParentContextPath: unexpectedCapability,
  }),
  Layer.mock(DiscussionSessionEnvironment, {}),
  Layer.mock(DrawBoardStorage, {}),
  Layer.mock(WindowStateStorage, {}),
  Layer.mock(InlineWidgets, {}),
  WorktreeLandingCoordinatorLive,
  Layer.mock(WorktreeLandingCompletion, {}),
  Layer.mock(WorktreeLandingAgent, {}),
  Layer.mock(PiSettings, {}),
  Layer.mock(ScheduledMessages, { snapshot: unexpectedCapability }),
  Layer.mock(WorkspaceFiles, {}),
  Layer.mock(NativeAttachments, {}),
  Layer.mock(AttachmentUploads, {}),
  Layer.succeed(ProjectConfiguration, { agentDirectory: "/agent" }),
  Layer.mock(RewordingRequests, {}),
  Layer.mock(PiAgentResources, {}),
  Layer.mock(ArtifactGarbageCollector, {}),
);
