import { Context, type Effect, type Stream } from "effect";
import type { BrowserWindow, WebContents } from "electron";
import type {
  cakeRpcPayloadSchemas,
  cakeRpcSuccessSchemas,
} from "../../contracts/application/cake-rpc-contract";
import type { ElectronError } from "../../contracts/desktop/electron-errors";

export const CAKE_TITLE_BAR_HEIGHT = 52;
export const VSCODE_TITLE_BAR_HEIGHT = 35;

type Payload<Type extends keyof typeof cakeRpcPayloadSchemas> =
  (typeof cakeRpcPayloadSchemas)[Type]["Type"];
type Success<Type extends keyof typeof cakeRpcSuccessSchemas> =
  (typeof cakeRpcSuccessSchemas)[Type]["Type"];

export interface ElectronWindowLifecycle {
  readonly onWindowCloseRequested: (connectionId: number) => void;
  readonly flushWindowState: (
    connectionId: number,
  ) => Effect.Effect<void, { readonly message: string }>;
  readonly backToAgentForWindow: (ownerId: number) => boolean;
  readonly onWindowClosed: (
    ownerId: number,
    workingDirectory: string | undefined,
    nativeId: number,
  ) => void;
  readonly allowProjectPath: (path: string) => Effect.Effect<void>;
  readonly canRewordSelection: () => boolean;
}

interface FullscreenSurfaceState {
  readonly connectionId: number;
  readonly open: boolean;
}

export interface ElectronService {
  readonly configureScreenCapture: (
    connectionId: number,
    request: Payload<"configure-screen-capture">,
  ) => Effect.Effect<Success<"configure-screen-capture">, ElectronError>;
  readonly configureCakeChatOverlay: (
    connectionId: number,
    request: Payload<"configure-cake-chat-overlay">,
  ) => Effect.Effect<Success<"configure-cake-chat-overlay">, ElectronError>;
  readonly hideCakeChatOverlay: (
    connectionId: number,
    request: Payload<"hide-cake-chat-overlay">,
  ) => Effect.Effect<Success<"hide-cake-chat-overlay">, ElectronError>;
  /** Hides the drop-down overlay and brings a main window forward, optionally opening a session. */
  readonly showMainWindow: (
    connectionId: number,
    request: Payload<"show-main-window">,
  ) => Effect.Effect<Success<"show-main-window">, ElectronError>;
  readonly captureWidgetView: (
    connectionId: number,
    request: Payload<"capture-widget-view">,
  ) => Effect.Effect<Success<"capture-widget-view">, ElectronError>;
  readonly startScreenCapture: (
    connectionId: number,
    request: Payload<"start-screen-capture">,
  ) => Effect.Effect<Success<"start-screen-capture">, ElectronError>;
  readonly screenCaptureState: (
    connectionId: number,
    request: Payload<"screen-capture-state">,
  ) => Effect.Effect<Success<"screen-capture-state">, ElectronError>;
  readonly finishScreenCapture: (
    connectionId: number,
    request: Payload<"finish-screen-capture">,
  ) => Effect.Effect<Success<"finish-screen-capture">, ElectronError>;
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
  readonly fullscreenSurfaceChanges: () => Stream.Stream<FullscreenSurfaceState>;

  readonly start: (lifecycle: ElectronWindowLifecycle) => Effect.Effect<void>;
  /** Brings the application window forward, recreating it when every window has been closed. */
  readonly focusOrCreateWindow: () => Effect.Effect<void>;
  /** Flush presentation state while the renderer transport is still running. */
  readonly prepareToQuit: () => Effect.Effect<boolean>;
  readonly closeWindow: (connectionId: number) => Effect.Effect<void>;
  readonly stop: () => Effect.Effect<void>;
  readonly requireRendererConnection: (connectionId: number) => WebContents;
  readonly windowsForWorkspace: (
    workingDirectory: string,
  ) => ReadonlyArray<readonly [connectionId: number, window: BrowserWindow]>;
  readonly centerTrafficLights: (window: BrowserWindow, titleBarHeight: number) => void;
}

export class Electron extends Context.Service<Electron, ElectronService>()(
  "cake/services/electron/Electron",
) {}
