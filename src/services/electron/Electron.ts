import { Context, Schema, type Effect } from "effect";
import type { BrowserWindow, WebContents } from "electron";
import type {
  CakeEvent,
  cakeRpcPayloadSchemas,
  cakeRpcSuccessSchemas,
} from "../../ipc/cake-rpc-contract";

export const CAKE_TITLE_BAR_HEIGHT = 46;
export const VSCODE_TITLE_BAR_HEIGHT = 35;

export class ElectronError extends Schema.TaggedError<ElectronError>()("ElectronError", {
  message: Schema.String,
}) {}

type Payload<Type extends keyof typeof cakeRpcPayloadSchemas> =
  (typeof cakeRpcPayloadSchemas)[Type]["Type"];
type Success<Type extends keyof typeof cakeRpcSuccessSchemas> =
  (typeof cakeRpcSuccessSchemas)[Type]["Type"];

export interface ElectronWindowLifecycle {
  readonly backToAgentForWindow: (ownerId: number) => boolean;
  readonly onWindowClosed: (ownerId: number, workingDirectory: string | undefined) => void;
  readonly allowProjectPath: (path: string) => Effect.Effect<void>;
  readonly hasUtilityModel: () => boolean;
}

export interface ElectronService {
  readonly chooseProject: (
    connectionId: number,
    request: Payload<"choose-project">,
  ) => Effect.Effect<Success<"choose-project">, ElectronError>;
  readonly openExternalUrl: (
    connectionId: number,
    request: Payload<"open-external-url">,
  ) => Effect.Effect<Success<"open-external-url">, ElectronError>;
  readonly showNotification: (
    connectionId: number,
    request: Payload<"show-notification">,
  ) => Effect.Effect<Success<"show-notification">, ElectronError>;
  readonly showTranscriptSelectionContextMenu: (
    connectionId: number,
    request: Payload<"show-transcript-selection-context-menu">,
  ) => Effect.Effect<Success<"show-transcript-selection-context-menu">, ElectronError>;
  readonly showComposerContextMenu: (
    connectionId: number,
    request: Payload<"show-composer-context-menu">,
  ) => Effect.Effect<Success<"show-composer-context-menu">, ElectronError>;
  readonly showSessionContextMenu: (
    connectionId: number,
    request: Payload<"show-session-context-menu">,
  ) => Effect.Effect<Success<"show-session-context-menu">, ElectronError>;
  readonly showProjectContextMenu: (
    connectionId: number,
    request: Payload<"show-project-context-menu">,
  ) => Effect.Effect<Success<"show-project-context-menu">, ElectronError>;
  readonly setFullscreenSurfaceOpen: (
    connectionId: number,
    request: Payload<"set-fullscreen-surface-open">,
  ) => Effect.Effect<Success<"set-fullscreen-surface-open">, ElectronError>;

  readonly start: (lifecycle: ElectronWindowLifecycle) => Effect.Effect<void>;
  readonly openExternal: (url: string) => Effect.Effect<void, ElectronError>;
  readonly stop: () => Effect.Effect<void>;
  readonly sendTo: (target: WebContents, event: CakeEvent) => void;
  readonly broadcast: (event: CakeEvent) => void;
  readonly requireRendererConnection: (connectionId: number) => WebContents;
  readonly workspaceForConnection: (connectionId: number) => string | undefined;
  readonly associateWorkspace: (connectionId: number, workingDirectory: string) => void;
  readonly forgetWorkspace: (workingDirectory: string) => void;
  readonly windowsForWorkspace: (
    workingDirectory: string,
  ) => ReadonlyArray<readonly [connectionId: number, window: BrowserWindow]>;
  readonly centerTrafficLights: (window: BrowserWindow, titleBarHeight: number) => void;
}

export class Electron extends Context.Service<Electron, ElectronService>()(
  "cake/services/electron/Electron",
) {}
