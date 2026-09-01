import { Effect } from "effect";
import type { CakeIpcClientService } from "../../ipc/client/CakeIpcClient";
import {
  nativeCommandSchemas,
  type NativeCommandResult,
  type NativeCommandType,
} from "../../ipc/native-contract";
import type { RendererClient, RendererCommandOptions } from "./RendererClient";

export type RendererClientCapabilities = Pick<
  RendererClient,
  | "electron"
  | "filesystem"
  | "workspaces"
  | "managedWorktrees"
  | "terminals"
  | "vscode"
  | "artifacts"
  | "plugins"
>;

type Group = keyof RendererClientCapabilities;
type Payload<Type extends NativeCommandType> = Omit<
  (typeof nativeCommandSchemas)[Type]["Type"],
  "type"
>;
type Execute = <Success, Failure>(
  operation: string,
  command: (client: CakeIpcClientService) => Effect.Effect<Success, Failure>,
  options?: RendererCommandOptions,
) => Promise<Success>;

function expectResponse<Type extends NativeCommandResult["type"]>(
  response: NativeCommandResult,
  type: Type,
): Extract<NativeCommandResult, { type: Type }> {
  if (response.type !== type) throw new Error(`Cake returned ${response.type}; expected ${type}`);
  // SAFETY: the discriminant check narrows the union to the requested response variant.
  return response as Extract<NativeCommandResult, { type: Type }>;
}

const widenResponse = (response: NativeCommandResult): NativeCommandResult => response;

export function makeRendererClientCapabilities(execute: Execute): RendererClientCapabilities {
  const command = <Type extends NativeCommandType>(
    group: Group,
    type: Type,
    payload: Payload<Type>,
    options?: RendererCommandOptions,
  ): Promise<NativeCommandResult> =>
    execute(
      `${group}.${type}`,
      (client) => {
        const commands = {
          ...client.electron,
          ...client.filesystem,
          ...client.workspaces,
          ...client.managedWorktrees,
          ...client.terminals,
          ...client.vscode,
          ...client.artifacts,
          ...client.plugins,
        };
        // SAFETY: Type selects both the protocol payload and generated command;
        // the mapped command table preserves that compile-time correlation.
        return commands[type](payload as never).pipe(Effect.map(widenResponse));
      },
      options,
    );

  const accept = async <Type extends NativeCommandType>(
    group: Group,
    type: Type,
    payload: Payload<Type> & { readonly requestId: string },
    options?: RendererCommandOptions,
  ) => {
    const response = await command(group, type, payload, options);
    if (response.type !== "accepted" || response.requestId !== payload.requestId)
      throw new Error(`Cake returned ${response.type}; expected acceptance for ${type}`);
  };

  return {
    electron: {
      chooseProject: (options) =>
        command("electron", "choose-project", {}, options).then(
          (response) => expectResponse(response, "project-chosen").path,
        ),
      openExternalUrl: (url, options) =>
        command("electron", "open-external-url", { url }, options).then((response) => {
          expectResponse(response, "external-url-opened");
        }),
      showTranscriptSelectionContextMenu: (input, options) =>
        command("electron", "show-transcript-selection-context-menu", { ...input }, options).then(
          (response) => expectResponse(response, "transcript-selection-context-menu-closed").action,
        ),
      showComposerContextMenu: (input, options) =>
        command("electron", "show-composer-context-menu", { ...input }, options).then(
          (response) => expectResponse(response, "composer-context-menu-closed").action,
        ),
      showSessionContextMenu: (input, options) =>
        command("electron", "show-session-context-menu", { ...input }, options).then(
          (response) => expectResponse(response, "session-context-menu-closed").action,
        ),
      showProjectContextMenu: (input, options) =>
        command("electron", "show-project-context-menu", { ...input }, options).then(
          (response) => expectResponse(response, "project-context-menu-closed").action,
        ),
      setFullscreenSurfaceOpen: (surfaceId, open, options) => {
        const requestId = crypto.randomUUID();
        return accept(
          "electron",
          "set-fullscreen-surface-open",
          { requestId, surfaceId, open },
          options,
        );
      },
    },
    filesystem: {
      chooseAttachments: (options) =>
        command("filesystem", "choose-attachments", {}, options).then(
          (response) => expectResponse(response, "attachments-chosen").attachments,
        ),
      suggestFiles: (workingDirectory, prefix, options) =>
        command(
          "filesystem",
          "suggest-files",
          { workspacePath: workingDirectory, prefix },
          options,
        ).then((response) => expectResponse(response, "file-suggestions").suggestions),
      readFile: (workingDirectory, path, options) =>
        command(
          "filesystem",
          "read-workspace-file",
          { workspacePath: workingDirectory, path },
          options,
        ).then((response) => expectResponse(response, "workspace-file").content),
    },
    workspaces: {
      rewordComposerSelection: (input, options) =>
        command(
          "workspaces",
          "reword-composer-selection",
          {
            selection: input.selection,
            prompt: input.prompt,
            workspacePath: input.workingDirectory,
          },
          options,
        ).then((response) => expectResponse(response, "composer-selection-reworded").text),
      generateSessionTitle: (firstUserMessage, options) =>
        command("workspaces", "generate-session-title", { firstUserMessage }, options).then(
          (response) => expectResponse(response, "session-title-generated").title,
        ),
      setUtilityModel: (model, options) =>
        command("workspaces", "set-utility-model", { model }, options).then(
          (response) => expectResponse(response, "application-state-updated").state,
        ),
      registerProject: (path, name, options) =>
        command("workspaces", "register-project", { path, name }, options).then(
          (response) => expectResponse(response, "application-state-updated").state,
        ),
      renameProject: (path, name, options) =>
        command("workspaces", "rename-project", { path, name }, options).then(
          (response) => expectResponse(response, "application-state-updated").state,
        ),
      removeProject: (path, deleteSessions, options) =>
        command("workspaces", "remove-project", { path, deleteSessions }, options).then(
          (response) => expectResponse(response, "application-state-updated").state,
        ),
      deleteSession: (sessionId, options) =>
        command("workspaces", "delete-session", { sessionId }, options).then(
          (response) => expectResponse(response, "application-state-updated").state,
        ),
      setSessionUnread: (sessionId, unread, options) =>
        command("workspaces", "set-session-unread", { sessionId, unread }, options).then(
          (response) => expectResponse(response, "application-state-updated").state,
        ),
      restartPi: (path, options) =>
        command("workspaces", "restart-pi", { path }, options).then(() => undefined),
      inspect: (input, options) =>
        accept(
          "workspaces",
          "inspect-workspace",
          { requestId: input.operationId, path: input.path },
          options,
        ),
      respondToTrust: (input, options) =>
        accept(
          "workspaces",
          "respond-workspace-trust",
          {
            requestId: input.operationId,
            path: input.path,
            approved: input.approved,
          },
          options,
        ),
    },
    managedWorktrees: {
      create: (input, options) =>
        command(
          "managedWorktrees",
          "create-worktree",
          {
            requestId: input.operationId,
            path: input.path,
            baseWorktreePath: input.baseWorktreePath,
            worktreeName: input.worktreeName,
            firstUserMessage: input.firstUserMessage,
          },
          options,
        ).then((response) => expectResponse(response, "worktree-created").record),
      status: (input, options) =>
        command("managedWorktrees", "get-worktree-status", { ...input }, options).then(
          (response) => expectResponse(response, "worktree-status-loaded").status,
        ),
      land: (input, options) =>
        command(
          "managedWorktrees",
          "land-worktree",
          {
            requestId: input.operationId,
            workspacePath: input.workspacePath,
            request: input.request,
          },
          options,
        ).then((response) => expectResponse(response, "worktree-landed").result),
      discard: (input, options) =>
        accept(
          "managedWorktrees",
          "discard-worktree",
          {
            requestId: input.operationId,
            workspacePath: input.workspacePath,
            keepBranch: input.keepBranch,
          },
          options,
        ),
    },
    terminals: {
      open: (input, options) => {
        const requestId = crypto.randomUUID();
        return command("terminals", "open-terminal", { requestId, ...input }, options).then(
          (response) => {
            const opened = expectResponse(response, "terminal-opened");
            if (opened.requestId !== requestId) throw new Error("Cake returned the wrong terminal");
            return { terminalId: opened.terminalId, shell: opened.shell };
          },
        );
      },
      write: (terminalId, data, options) => {
        const requestId = crypto.randomUUID();
        return accept("terminals", "write-terminal", { requestId, terminalId, data }, options);
      },
      resize: (terminalId, cols, rows, options) => {
        const requestId = crypto.randomUUID();
        return accept(
          "terminals",
          "resize-terminal",
          { requestId, terminalId, cols, rows },
          options,
        );
      },
      status: (terminalId, options) => {
        const requestId = crypto.randomUUID();
        return command("terminals", "get-terminal-status", { requestId, terminalId }, options).then(
          (response) => {
            const status = expectResponse(response, "terminal-status");
            if (status.requestId !== requestId) throw new Error("Cake returned the wrong terminal");
            return { runningProgram: status.runningProgram };
          },
        );
      },
      close: (terminalId, options) => {
        const requestId = crypto.randomUUID();
        return accept("terminals", "close-terminal", { requestId, terminalId }, options);
      },
    },
    vscode: {
      getState: (options) =>
        command("vscode", "get-embedded-editor-state", {}, options).then((response) => {
          const state = expectResponse(response, "embedded-editor-state-loaded");
          return { status: state.status, message: state.message, customPath: state.customPath };
        }),
      install: (options) => {
        const requestId = crypto.randomUUID();
        return accept("vscode", "install-embedded-editor", { requestId }, options);
      },
      setServerPath: (path, options) =>
        command("vscode", "set-vscode-server-path", { path }, options).then(
          (response) => expectResponse(response, "application-state-updated").state,
        ),
      open: (workingDirectory, options) => {
        const requestId = crypto.randomUUID();
        return accept(
          "vscode",
          "open-embedded-editor",
          { requestId, workspacePath: workingDirectory },
          options,
        );
      },
      updateBounds: (input, options) => {
        const requestId = crypto.randomUUID();
        return accept("vscode", "update-embedded-editor-bounds", { requestId, ...input }, options);
      },
      reveal: (workingDirectory, location, options) => {
        const requestId = crypto.randomUUID();
        return accept(
          "vscode",
          "reveal-in-embedded-editor",
          {
            requestId,
            workspacePath: workingDirectory,
            location,
          },
          options,
        );
      },
      openSourceControl: (workingDirectory, options) => {
        const requestId = crypto.randomUUID();
        return accept(
          "vscode",
          "open-embedded-editor-source-control",
          {
            requestId,
            workspacePath: workingDirectory,
          },
          options,
        );
      },
      updateAnnotations: (workingDirectory, snapshot, options) => {
        const requestId = crypto.randomUUID();
        return accept(
          "vscode",
          "update-embedded-editor-annotations",
          {
            requestId,
            workspacePath: workingDirectory,
            snapshot,
          },
          options,
        );
      },
    },
    artifacts: {
      respond: (input, options) =>
        command(
          "artifacts",
          "respond-artifact",
          {
            requestId: input.operationId,
            sessionId: input.sessionId,
            artifactRequestId: input.artifactRequestId,
            value: input.value,
            cancelled: input.cancelled,
          },
          options,
        ).then((response) => {
          expectResponse(response, "artifact-response-accepted");
        }),
      respondToUi: (input, options) =>
        command(
          "artifacts",
          "respond-ui",
          {
            requestId: input.operationId,
            sessionId: input.sessionId,
            uiRequestId: input.uiRequestId,
            value: input.value,
            cancelled: input.cancelled,
          },
          options,
        ).then((response) => {
          expectResponse(response, "ui-response-accepted");
        }),
      export: (sessionId, options) =>
        command("artifacts", "export-artifacts", { sessionId }, options).then(
          (response) => expectResponse(response, "artifacts-exported").markdown,
        ),
    },
    plugins: {
      getCustomizationState: (options) =>
        command("plugins", "get-customization-state", {}, options).then(
          (response) => expectResponse(response, "customization-state").state,
        ),
      getAuthoringReference: (options) =>
        command("plugins", "get-plugin-authoring-reference", {}, options).then(
          (response) => expectResponse(response, "plugin-authoring-reference").reference,
        ),
      listFiles: (options) =>
        command("plugins", "list-plugin-files", {}, options).then((response) =>
          expectResponse(response, "plugin-files"),
        ),
      create: (input, options) =>
        command("plugins", "create-plugin", { ...input }, options).then((response) =>
          expectResponse(response, "plugin-files"),
        ),
      readFile: (pluginId, path, options) =>
        command("plugins", "read-plugin-file", { pluginId, path }, options).then(
          (response) => expectResponse(response, "plugin-file").content,
        ),
      writeFile: (pluginId, path, content, expectedWorkingRevision, options) =>
        command(
          "plugins",
          "write-plugin-file",
          { pluginId, path, content, expectedWorkingRevision },
          options,
        ).then((response) => expectResponse(response, "plugin-files")),
      validate: (expectedBaseRevision, request, expectedSourceRevision, options) =>
        command(
          "plugins",
          "validate-customization",
          { expectedBaseRevision, request, expectedSourceRevision },
          options,
        ).then((response) => expectResponse(response, "customization-validation")),
      activate: (revision, expectedSourceRevision, request, options) =>
        command(
          "plugins",
          "activate-customization",
          { revision, expectedSourceRevision, request },
          options,
        ).then((response) => expectResponse(response, "customization-activation")),
      rollback: (options) =>
        command("plugins", "rollback-customization", {}, options).then(
          (response) => expectResponse(response, "customization-state").state,
        ),
      useFactory: (options) =>
        command("plugins", "use-factory-customization", {}, options).then(
          (response) => expectResponse(response, "customization-state").state,
        ),
      list: (options) =>
        command("plugins", "list-plugins", {}, options).then(
          (response) => expectResponse(response, "plugins-listed").plugins,
        ),
      setEnabled: (pluginId, enabled, options) =>
        command("plugins", "set-plugin-enabled", { pluginId, enabled }, options).then(
          (response) => expectResponse(response, "plugins-listed").plugins,
        ),
      setActiveScene: (pluginId, options) =>
        command("plugins", "set-active-scene", { pluginId }, options).then(
          (response) => expectResponse(response, "plugins-listed").plugins,
        ),
      delete: (pluginId, options) =>
        command("plugins", "delete-plugin", { pluginId }, options).then(
          (response) => expectResponse(response, "plugins-listed").plugins,
        ),
      compileInlineWidget: (language, source, capability, options) =>
        command("plugins", "compile-inline-widget", { language, source, capability }, options).then(
          (response) => expectResponse(response, "inline-widget-compiled").widget,
        ),
      repairInlineWidget: (input, options) =>
        command("plugins", "repair-inline-widget", { ...input }, options).then(
          (response) => expectResponse(response, "inline-widget-repaired").widget,
        ),
      openAgent: (pluginId, input, implicitSession, options) =>
        command(
          "plugins",
          "open-plugin-agent",
          { pluginId, options: input, implicitSession },
          options,
        ).then((response) => expectResponse(response, "plugin-agent-snapshot").snapshot),
      promptAgent: (pluginId, handleId, delivery, text, options) =>
        command(
          "plugins",
          "prompt-plugin-agent",
          { pluginId, handleId, delivery, text },
          options,
        ).then((response) => expectResponse(response, "plugin-agent-snapshot").snapshot),
      abortAgent: (pluginId, handleId, options) =>
        command("plugins", "abort-plugin-agent", { pluginId, handleId }, options).then(
          (response) => expectResponse(response, "plugin-agent-snapshot").snapshot,
        ),
      detachAgent: (pluginId, handleId, options) =>
        command("plugins", "detach-plugin-agent", { pluginId, handleId }, options).then(
          (response) => {
            expectResponse(response, "plugin-agent-detached");
          },
        ),
      runCompletion: (pluginId, requestId, request, implicitSession, options) =>
        command(
          "plugins",
          "run-plugin-completion",
          { pluginId, requestId, request, implicitSession },
          options,
        ).then((response) => expectResponse(response, "plugin-completion-result").result),
      cancelCompletion: (pluginId, requestId, options) =>
        command("plugins", "cancel-plugin-completion", { pluginId, requestId }, options).then(
          () => undefined,
        ),
      loadState: (pluginId, key, scope, options) =>
        command("plugins", "load-plugin-state", { pluginId, key, scope }, options).then(
          (response) => expectResponse(response, "plugin-state").record,
        ),
      saveState: (input, options) =>
        command("plugins", "save-plugin-state", { ...input }, options).then((response) => {
          const record = expectResponse(response, "plugin-state").record;
          if (!record) throw new Error("Cake did not persist plugin state");
          return record;
        }),
      callBackend: (input, options) =>
        command("plugins", "call-plugin-backend", { ...input }, options).then((response) => {
          const result = expectResponse(response, "plugin-backend-result");
          return { ok: result.ok, value: result.value, error: result.error };
        }),
      cancelBackendCall: (pluginId, callId, options) =>
        command("plugins", "cancel-plugin-backend-call", { pluginId, callId }, options).then(
          () => undefined,
        ),
      reportRendered: (revision, options) =>
        command("plugins", "customization-rendered", { revision }, options).then(() => undefined),
      reportRuntimeFailure: (revision, message, options) =>
        command("plugins", "customization-runtime-failed", { revision, message }, options).then(
          () => undefined,
        ),
    },
  };
}
