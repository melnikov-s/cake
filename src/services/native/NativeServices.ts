import { Context, Effect, Layer, Queue, Schema, Stream } from "effect";
import type { NativeEvent, NativeOperationType } from "../../ipc/native-protocol";
import type {
  nativeOperationPayloadSchemas,
  nativeOperationSuccessSchemas,
} from "../../ipc/native-protocol";

export class NativeOperationError extends Schema.TaggedError<NativeOperationError>()(
  "NativeOperationError",
  { message: Schema.String },
) {}

export type NativeStreamElement = NativeEvent | { readonly type: "native-stream-ready" };

type NativePayload<Type extends NativeOperationType> =
  (typeof nativeOperationPayloadSchemas)[Type]["Type"];
type NativeSuccess<Type extends NativeOperationType> =
  (typeof nativeOperationSuccessSchemas)[Type]["Type"];
type NativePromiseOperation<Type extends NativeOperationType> = (
  connectionId: number,
  payload: NativePayload<Type>,
) => Promise<NativeSuccess<Type>>;
type NativeEffectOperation<Type extends NativeOperationType> = (
  connectionId: number,
  payload: NativePayload<Type>,
) => Effect.Effect<NativeSuccess<Type>, NativeOperationError>;
type OperationGroup<Types extends NativeOperationType, Operation extends "promise" | "effect"> = {
  readonly [Type in Types]: Operation extends "promise"
    ? NativePromiseOperation<Type>
    : NativeEffectOperation<Type>;
};

export type ElectronNativeOperation =
  | "choose-project"
  | "open-external-url"
  | "show-transcript-selection-context-menu"
  | "show-composer-context-menu"
  | "show-session-context-menu"
  | "show-project-context-menu"
  | "set-fullscreen-surface-open";
export type FilesystemNativeOperation =
  | "choose-attachments"
  | "suggest-files"
  | "read-workspace-file";
export type WorkspaceNativeOperation =
  | "reword-composer-selection"
  | "generate-session-title"
  | "set-utility-model"
  | "register-project"
  | "rename-project"
  | "remove-project"
  | "delete-session"
  | "set-session-unread"
  | "restart-pi"
  | "inspect-workspace"
  | "respond-workspace-trust";
export type ManagedWorktreeNativeOperation =
  | "create-worktree"
  | "get-worktree-status"
  | "land-worktree"
  | "discard-worktree";
export type TerminalNativeOperation =
  | "open-terminal"
  | "write-terminal"
  | "resize-terminal"
  | "get-terminal-status"
  | "close-terminal";
export type VsCodeNativeOperation =
  | "get-embedded-editor-state"
  | "set-vscode-server-path"
  | "install-embedded-editor"
  | "open-embedded-editor"
  | "update-embedded-editor-bounds"
  | "reveal-in-embedded-editor"
  | "open-embedded-editor-source-control"
  | "update-embedded-editor-annotations";
export type ArtifactNativeOperation = "respond-artifact" | "respond-ui" | "export-artifacts";
export type PluginNativeOperation =
  | "get-customization-state"
  | "get-plugin-authoring-reference"
  | "list-plugin-files"
  | "create-plugin"
  | "read-plugin-file"
  | "write-plugin-file"
  | "validate-customization"
  | "activate-customization"
  | "rollback-customization"
  | "use-factory-customization"
  | "list-plugins"
  | "set-plugin-enabled"
  | "set-active-scene"
  | "delete-plugin"
  | "compile-inline-widget"
  | "repair-inline-widget"
  | "open-plugin-agent"
  | "prompt-plugin-agent"
  | "abort-plugin-agent"
  | "detach-plugin-agent"
  | "run-plugin-completion"
  | "cancel-plugin-completion"
  | "load-plugin-state"
  | "save-plugin-state"
  | "call-plugin-backend"
  | "cancel-plugin-backend-call"
  | "customization-rendered"
  | "customization-runtime-failed";

export interface NativeServiceOperations {
  readonly electron: OperationGroup<ElectronNativeOperation, "promise">;
  readonly filesystem: OperationGroup<FilesystemNativeOperation, "promise">;
  readonly workspaces: OperationGroup<WorkspaceNativeOperation, "promise">;
  readonly managedWorktrees: OperationGroup<ManagedWorktreeNativeOperation, "promise">;
  readonly terminals: OperationGroup<TerminalNativeOperation, "promise">;
  readonly vscode: OperationGroup<VsCodeNativeOperation, "promise">;
  readonly artifacts: OperationGroup<ArtifactNativeOperation, "promise">;
  readonly plugins: OperationGroup<PluginNativeOperation, "promise">;
  readonly subscribe: (connectionId: number, listener: (event: NativeEvent) => void) => () => void;
}

export class Electron extends Context.Service<
  Electron,
  OperationGroup<ElectronNativeOperation, "effect">
>()("cake/services/native/Electron") {}
export class Filesystem extends Context.Service<
  Filesystem,
  OperationGroup<FilesystemNativeOperation, "effect">
>()("cake/services/native/Filesystem") {}
export class Workspaces extends Context.Service<
  Workspaces,
  OperationGroup<WorkspaceNativeOperation, "effect">
>()("cake/services/native/Workspaces") {}
export class ManagedWorktrees extends Context.Service<
  ManagedWorktrees,
  OperationGroup<ManagedWorktreeNativeOperation, "effect">
>()("cake/services/native/ManagedWorktrees") {}
export class Terminals extends Context.Service<
  Terminals,
  OperationGroup<TerminalNativeOperation, "effect">
>()("cake/services/native/Terminals") {}
export class VsCode extends Context.Service<
  VsCode,
  OperationGroup<VsCodeNativeOperation, "effect">
>()("cake/services/native/VsCode") {}
export class Artifacts extends Context.Service<
  Artifacts,
  OperationGroup<ArtifactNativeOperation, "effect">
>()("cake/services/native/Artifacts") {}
export class Plugins extends Context.Service<
  Plugins,
  OperationGroup<PluginNativeOperation, "effect">
>()("cake/services/native/Plugins") {}
type FocusedNativeEvent<Types extends NativeEvent["type"]> =
  | Extract<NativeEvent, { readonly type: Types }>
  | { readonly type: "native-stream-ready" };

export class NativeEvents extends Context.Service<
  NativeEvents,
  {
    readonly application: (
      connectionId: number,
    ) => Stream.Stream<
      FocusedNativeEvent<
        | "pi-state"
        | "workspace-inspected"
        | "changelog-snapshot"
        | "complete"
        | "fatal"
        | "application-state-changed"
        | "notification"
      >
    >;
    readonly artifacts: (
      connectionId: number,
    ) => Stream.Stream<
      FocusedNativeEvent<"artifact-updated" | "artifact-requested" | "ui-request">
    >;
    readonly plugins: (
      connectionId: number,
    ) => Stream.Stream<
      FocusedNativeEvent<
        "plugin-backend-event" | "customization-state-changed" | "plugin-agent-event"
      >
    >;
    readonly terminals: (
      connectionId: number,
    ) => Stream.Stream<
      FocusedNativeEvent<"terminal-data" | "terminal-exited" | "terminal-toggle-requested">
    >;
    readonly vscode: (
      connectionId: number,
    ) => Stream.Stream<
      FocusedNativeEvent<
        | "embedded-editor-state"
        | "embedded-editor-selection"
        | "embedded-editor-back-to-agent"
        | "embedded-editor-annotation-opened"
        | "embedded-editor-toggle-chat"
        | "embedded-editor-selection-cleared"
        | "embedded-editor-location-opened"
      >
    >;
    readonly surfaces: (
      connectionId: number,
    ) => Stream.Stream<FocusedNativeEvent<"fullscreen-surface-close-requested">>;
  }
>()("cake/services/native/NativeEvents") {}

const nativeError = (error: unknown) =>
  new NativeOperationError({ message: error instanceof Error ? error.message : String(error) });

const operation = <Type extends NativeOperationType>(
  name: string,
  execute: NativePromiseOperation<Type>,
): NativeEffectOperation<Type> =>
  Effect.fn(name)((connectionId, payload) =>
    Effect.tryPromise({
      try: () => execute(connectionId, payload),
      catch: nativeError,
    }),
  );
export const makeNativeServicesLive = (operations: NativeServiceOperations) => {
  const observe = (connectionId: number) =>
    Stream.callback<NativeStreamElement>((queue) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          const unsubscribe = operations.subscribe(connectionId, (event) => {
            Queue.offerUnsafe(queue, event);
          });
          Queue.offerUnsafe(queue, { type: "native-stream-ready" });
          return unsubscribe;
        }),
        (unsubscribe) => Effect.sync(unsubscribe),
      ),
    );
  const focused = <Types extends NativeEvent["type"]>(
    connectionId: number,
    ...types: ReadonlyArray<Types>
  ): Stream.Stream<FocusedNativeEvent<Types>> => {
    const accepted = new Set<NativeEvent["type"]>(types);
    return observe(connectionId).pipe(
      Stream.filter(
        (event): event is FocusedNativeEvent<Types> =>
          event.type === "native-stream-ready" || accepted.has(event.type),
      ),
    );
  };

  return Layer.mergeAll(
    Layer.succeed(Electron, {
      "choose-project": operation("Electron.chooseProject", operations.electron["choose-project"]),
      "open-external-url": operation(
        "Electron.openExternalUrl",
        operations.electron["open-external-url"],
      ),
      "show-transcript-selection-context-menu": operation(
        "Electron.showTranscriptSelectionContextMenu",
        operations.electron["show-transcript-selection-context-menu"],
      ),
      "show-composer-context-menu": operation(
        "Electron.showComposerContextMenu",
        operations.electron["show-composer-context-menu"],
      ),
      "show-session-context-menu": operation(
        "Electron.showSessionContextMenu",
        operations.electron["show-session-context-menu"],
      ),
      "show-project-context-menu": operation(
        "Electron.showProjectContextMenu",
        operations.electron["show-project-context-menu"],
      ),
      "set-fullscreen-surface-open": operation(
        "Electron.setFullscreenSurfaceOpen",
        operations.electron["set-fullscreen-surface-open"],
      ),
    }),
    Layer.succeed(Filesystem, {
      "choose-attachments": operation(
        "Filesystem.chooseAttachments",
        operations.filesystem["choose-attachments"],
      ),
      "suggest-files": operation("Filesystem.suggestFiles", operations.filesystem["suggest-files"]),
      "read-workspace-file": operation(
        "Filesystem.readWorkspaceFile",
        operations.filesystem["read-workspace-file"],
      ),
    }),
    Layer.succeed(Workspaces, {
      "reword-composer-selection": operation(
        "Workspaces.rewordComposerSelection",
        operations.workspaces["reword-composer-selection"],
      ),
      "generate-session-title": operation(
        "Workspaces.generateSessionTitle",
        operations.workspaces["generate-session-title"],
      ),
      "set-utility-model": operation(
        "Workspaces.setUtilityModel",
        operations.workspaces["set-utility-model"],
      ),
      "register-project": operation(
        "Workspaces.registerProject",
        operations.workspaces["register-project"],
      ),
      "rename-project": operation(
        "Workspaces.renameProject",
        operations.workspaces["rename-project"],
      ),
      "remove-project": operation(
        "Workspaces.removeProject",
        operations.workspaces["remove-project"],
      ),
      "delete-session": operation(
        "Workspaces.deleteSession",
        operations.workspaces["delete-session"],
      ),
      "set-session-unread": operation(
        "Workspaces.setSessionUnread",
        operations.workspaces["set-session-unread"],
      ),
      "restart-pi": operation("Workspaces.restartPi", operations.workspaces["restart-pi"]),
      "inspect-workspace": operation(
        "Workspaces.inspect",
        operations.workspaces["inspect-workspace"],
      ),
      "respond-workspace-trust": operation(
        "Workspaces.respondToTrust",
        operations.workspaces["respond-workspace-trust"],
      ),
    }),
    Layer.succeed(ManagedWorktrees, {
      "create-worktree": operation(
        "ManagedWorktrees.create",
        operations.managedWorktrees["create-worktree"],
      ),
      "get-worktree-status": operation(
        "ManagedWorktrees.status",
        operations.managedWorktrees["get-worktree-status"],
      ),
      "land-worktree": operation(
        "ManagedWorktrees.land",
        operations.managedWorktrees["land-worktree"],
      ),
      "discard-worktree": operation(
        "ManagedWorktrees.discard",
        operations.managedWorktrees["discard-worktree"],
      ),
    }),
    Layer.succeed(Terminals, {
      "open-terminal": operation("Terminal.open", operations.terminals["open-terminal"]),
      "write-terminal": operation("Terminal.write", operations.terminals["write-terminal"]),
      "resize-terminal": operation("Terminal.resize", operations.terminals["resize-terminal"]),
      "get-terminal-status": operation(
        "Terminal.status",
        operations.terminals["get-terminal-status"],
      ),
      "close-terminal": operation("Terminal.close", operations.terminals["close-terminal"]),
    }),
    Layer.succeed(VsCode, {
      "get-embedded-editor-state": operation(
        "VsCodeServer.getState",
        operations.vscode["get-embedded-editor-state"],
      ),
      "set-vscode-server-path": operation(
        "VsCodeServer.setPath",
        operations.vscode["set-vscode-server-path"],
      ),
      "install-embedded-editor": operation(
        "VsCodeServer.install",
        operations.vscode["install-embedded-editor"],
      ),
      "open-embedded-editor": operation(
        "VsCodeServer.open",
        operations.vscode["open-embedded-editor"],
      ),
      "update-embedded-editor-bounds": operation(
        "VsCodeServer.updateBounds",
        operations.vscode["update-embedded-editor-bounds"],
      ),
      "reveal-in-embedded-editor": operation(
        "VsCodeServer.reveal",
        operations.vscode["reveal-in-embedded-editor"],
      ),
      "open-embedded-editor-source-control": operation(
        "VsCodeServer.openSourceControl",
        operations.vscode["open-embedded-editor-source-control"],
      ),
      "update-embedded-editor-annotations": operation(
        "VsCodeServer.updateAnnotations",
        operations.vscode["update-embedded-editor-annotations"],
      ),
    }),
    Layer.succeed(Artifacts, {
      "respond-artifact": operation("Artifacts.respond", operations.artifacts["respond-artifact"]),
      "respond-ui": operation("Artifacts.respondUi", operations.artifacts["respond-ui"]),
      "export-artifacts": operation("Artifacts.export", operations.artifacts["export-artifacts"]),
    }),
    Layer.succeed(Plugins, {
      "get-customization-state": operation(
        "Plugins.getCustomizationState",
        operations.plugins["get-customization-state"],
      ),
      "get-plugin-authoring-reference": operation(
        "Plugins.getAuthoringReference",
        operations.plugins["get-plugin-authoring-reference"],
      ),
      "list-plugin-files": operation("Plugins.listFiles", operations.plugins["list-plugin-files"]),
      "create-plugin": operation("Plugins.create", operations.plugins["create-plugin"]),
      "read-plugin-file": operation("Plugins.readFile", operations.plugins["read-plugin-file"]),
      "write-plugin-file": operation("Plugins.writeFile", operations.plugins["write-plugin-file"]),
      "validate-customization": operation(
        "Plugins.validate",
        operations.plugins["validate-customization"],
      ),
      "activate-customization": operation(
        "Plugins.activate",
        operations.plugins["activate-customization"],
      ),
      "rollback-customization": operation(
        "Plugins.rollback",
        operations.plugins["rollback-customization"],
      ),
      "use-factory-customization": operation(
        "Plugins.useFactory",
        operations.plugins["use-factory-customization"],
      ),
      "list-plugins": operation("Plugins.list", operations.plugins["list-plugins"]),
      "set-plugin-enabled": operation(
        "Plugins.setEnabled",
        operations.plugins["set-plugin-enabled"],
      ),
      "set-active-scene": operation(
        "Plugins.setActiveScene",
        operations.plugins["set-active-scene"],
      ),
      "delete-plugin": operation("Plugins.delete", operations.plugins["delete-plugin"]),
      "compile-inline-widget": operation(
        "Plugins.compileInlineWidget",
        operations.plugins["compile-inline-widget"],
      ),
      "repair-inline-widget": operation(
        "Plugins.repairInlineWidget",
        operations.plugins["repair-inline-widget"],
      ),
      "open-plugin-agent": operation("Plugins.openAgent", operations.plugins["open-plugin-agent"]),
      "prompt-plugin-agent": operation(
        "Plugins.promptAgent",
        operations.plugins["prompt-plugin-agent"],
      ),
      "abort-plugin-agent": operation(
        "Plugins.abortAgent",
        operations.plugins["abort-plugin-agent"],
      ),
      "detach-plugin-agent": operation(
        "Plugins.detachAgent",
        operations.plugins["detach-plugin-agent"],
      ),
      "run-plugin-completion": operation(
        "Plugins.runCompletion",
        operations.plugins["run-plugin-completion"],
      ),
      "cancel-plugin-completion": operation(
        "Plugins.cancelCompletion",
        operations.plugins["cancel-plugin-completion"],
      ),
      "load-plugin-state": operation("Plugins.loadState", operations.plugins["load-plugin-state"]),
      "save-plugin-state": operation("Plugins.saveState", operations.plugins["save-plugin-state"]),
      "call-plugin-backend": operation(
        "Plugins.callBackend",
        operations.plugins["call-plugin-backend"],
      ),
      "cancel-plugin-backend-call": operation(
        "Plugins.cancelBackendCall",
        operations.plugins["cancel-plugin-backend-call"],
      ),
      "customization-rendered": operation(
        "Plugins.reportRendered",
        operations.plugins["customization-rendered"],
      ),
      "customization-runtime-failed": operation(
        "Plugins.reportRuntimeFailure",
        operations.plugins["customization-runtime-failed"],
      ),
    }),
    Layer.succeed(NativeEvents, {
      application: (connectionId) =>
        focused(
          connectionId,
          "pi-state",
          "workspace-inspected",
          "changelog-snapshot",
          "complete",
          "fatal",
          "application-state-changed",
          "notification",
        ),
      artifacts: (connectionId) =>
        focused(connectionId, "artifact-updated", "artifact-requested", "ui-request"),
      plugins: (connectionId) =>
        focused(
          connectionId,
          "plugin-backend-event",
          "customization-state-changed",
          "plugin-agent-event",
        ),
      terminals: (connectionId) =>
        focused(connectionId, "terminal-data", "terminal-exited", "terminal-toggle-requested"),
      vscode: (connectionId) =>
        focused(
          connectionId,
          "embedded-editor-state",
          "embedded-editor-selection",
          "embedded-editor-back-to-agent",
          "embedded-editor-annotation-opened",
          "embedded-editor-toggle-chat",
          "embedded-editor-selection-cleared",
          "embedded-editor-location-opened",
        ),
      surfaces: (connectionId) => focused(connectionId, "fullscreen-surface-close-requested"),
    }),
  );
};
