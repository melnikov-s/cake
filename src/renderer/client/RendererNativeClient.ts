import type {
  PrivilegedRequest,
  PrivilegedResponse,
  PrivilegedRouteType,
} from "../../ipc/privileged-contract";

type RoutedPrivilegedRequest = Extract<PrivilegedRequest, { type: PrivilegedRouteType }>;
import type { RendererClient, RendererCommandOptions } from "./RendererClient";

export type RendererNativeClient = Pick<
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

type Group = keyof RendererNativeClient;
type Invoke = (
  group: Group,
  request: RoutedPrivilegedRequest,
  options?: RendererCommandOptions,
) => Promise<PrivilegedResponse>;
type Accept = (
  group: Group,
  request: RoutedPrivilegedRequest & { requestId: string },
  options?: RendererCommandOptions,
) => Promise<void>;

function expectResponse<Type extends PrivilegedResponse["type"]>(
  response: PrivilegedResponse,
  type: Type,
): Extract<PrivilegedResponse, { type: Type }> {
  if (response.type !== type) throw new Error(`Cake returned ${response.type}; expected ${type}`);
  // SAFETY: the discriminant check narrows the union to the requested response variant.
  return response as Extract<PrivilegedResponse, { type: Type }>;
}

export function makeRendererNativeClient(invoke: Invoke, accept: Accept): RendererNativeClient {
  return {
    electron: {
      chooseProject: (options) =>
        invoke("electron", { type: "choose-project" }, options).then(
          (response) => expectResponse(response, "project-chosen").path,
        ),
      openExternalUrl: (url, options) =>
        invoke("electron", { type: "open-external-url", url }, options).then((response) => {
          expectResponse(response, "external-url-opened");
        }),
      showTranscriptSelectionContextMenu: (input, options) =>
        invoke(
          "electron",
          { type: "show-transcript-selection-context-menu", ...input },
          options,
        ).then(
          (response) => expectResponse(response, "transcript-selection-context-menu-closed").action,
        ),
      showComposerContextMenu: (input, options) =>
        invoke("electron", { type: "show-composer-context-menu", ...input }, options).then(
          (response) => expectResponse(response, "composer-context-menu-closed").action,
        ),
      showSessionContextMenu: (input, options) =>
        invoke("electron", { type: "show-session-context-menu", ...input }, options).then(
          (response) => expectResponse(response, "session-context-menu-closed").action,
        ),
      showProjectContextMenu: (input, options) =>
        invoke("electron", { type: "show-project-context-menu", ...input }, options).then(
          (response) => expectResponse(response, "project-context-menu-closed").action,
        ),
      setFullscreenSurfaceOpen: (surfaceId, open, options) => {
        const requestId = crypto.randomUUID();
        return accept(
          "electron",
          { type: "set-fullscreen-surface-open", requestId, surfaceId, open },
          options,
        );
      },
    },
    filesystem: {
      chooseAttachments: (options) =>
        invoke("filesystem", { type: "choose-attachments" }, options).then(
          (response) => expectResponse(response, "attachments-chosen").attachments,
        ),
      suggestFiles: (workingDirectory, prefix, options) =>
        invoke(
          "filesystem",
          { type: "suggest-files", workspacePath: workingDirectory, prefix },
          options,
        ).then((response) => expectResponse(response, "file-suggestions").suggestions),
      readFile: (workingDirectory, path, options) =>
        invoke(
          "filesystem",
          { type: "read-workspace-file", workspacePath: workingDirectory, path },
          options,
        ).then((response) => expectResponse(response, "workspace-file").content),
    },
    workspaces: {
      rewordComposerSelection: (input, options) =>
        invoke(
          "workspaces",
          {
            type: "reword-composer-selection",
            selection: input.selection,
            prompt: input.prompt,
            workspacePath: input.workingDirectory,
          },
          options,
        ).then((response) => expectResponse(response, "composer-selection-reworded").text),
      generateSessionTitle: (firstUserMessage, options) =>
        invoke("workspaces", { type: "generate-session-title", firstUserMessage }, options).then(
          (response) => expectResponse(response, "session-title-generated").title,
        ),
      setUtilityModel: (model, options) =>
        invoke("workspaces", { type: "set-utility-model", model }, options).then(
          (response) => expectResponse(response, "application-state-updated").state,
        ),
      registerProject: (path, name, options) =>
        invoke("workspaces", { type: "register-project", path, name }, options).then(
          (response) => expectResponse(response, "application-state-updated").state,
        ),
      renameProject: (path, name, options) =>
        invoke("workspaces", { type: "rename-project", path, name }, options).then(
          (response) => expectResponse(response, "application-state-updated").state,
        ),
      removeProject: (path, deleteSessions, options) =>
        invoke("workspaces", { type: "remove-project", path, deleteSessions }, options).then(
          (response) => expectResponse(response, "application-state-updated").state,
        ),
      deleteSession: (sessionId, options) =>
        invoke("workspaces", { type: "delete-session", sessionId }, options).then(
          (response) => expectResponse(response, "application-state-updated").state,
        ),
      setSessionUnread: (sessionId, unread, options) =>
        invoke("workspaces", { type: "set-session-unread", sessionId, unread }, options).then(
          (response) => expectResponse(response, "application-state-updated").state,
        ),
      restartPi: (path, options) =>
        invoke("workspaces", { type: "restart-pi", path }, options).then(() => undefined),
      inspect: (input, options) =>
        accept(
          "workspaces",
          { type: "inspect-workspace", requestId: input.operationId, path: input.path },
          options,
        ),
      respondToTrust: (input, options) =>
        accept(
          "workspaces",
          {
            type: "respond-workspace-trust",
            requestId: input.operationId,
            path: input.path,
            approved: input.approved,
          },
          options,
        ),
    },
    managedWorktrees: {
      create: (input, options) =>
        invoke(
          "managedWorktrees",
          {
            type: "create-worktree",
            requestId: input.operationId,
            path: input.path,
            baseWorktreePath: input.baseWorktreePath,
            worktreeName: input.worktreeName,
            firstUserMessage: input.firstUserMessage,
          },
          options,
        ).then((response) => expectResponse(response, "worktree-created").record),
      status: (input, options) =>
        invoke("managedWorktrees", { type: "get-worktree-status", ...input }, options).then(
          (response) => expectResponse(response, "worktree-status-loaded").status,
        ),
      land: (input, options) =>
        invoke(
          "managedWorktrees",
          {
            type: "land-worktree",
            requestId: input.operationId,
            workspacePath: input.workspacePath,
            request: input.request,
          },
          options,
        ).then((response) => expectResponse(response, "worktree-landed").result),
      discard: (input, options) =>
        accept(
          "managedWorktrees",
          {
            type: "discard-worktree",
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
        return invoke("terminals", { type: "open-terminal", requestId, ...input }, options).then(
          (response) => {
            const opened = expectResponse(response, "terminal-opened");
            if (opened.requestId !== requestId) throw new Error("Cake returned the wrong terminal");
            return { terminalId: opened.terminalId, shell: opened.shell };
          },
        );
      },
      write: (terminalId, data, options) => {
        const requestId = crypto.randomUUID();
        return accept(
          "terminals",
          { type: "write-terminal", requestId, terminalId, data },
          options,
        );
      },
      resize: (terminalId, cols, rows, options) => {
        const requestId = crypto.randomUUID();
        return accept(
          "terminals",
          { type: "resize-terminal", requestId, terminalId, cols, rows },
          options,
        );
      },
      status: (terminalId, options) => {
        const requestId = crypto.randomUUID();
        return invoke(
          "terminals",
          { type: "get-terminal-status", requestId, terminalId },
          options,
        ).then((response) => {
          const status = expectResponse(response, "terminal-status");
          if (status.requestId !== requestId) throw new Error("Cake returned the wrong terminal");
          return { runningProgram: status.runningProgram };
        });
      },
      close: (terminalId, options) => {
        const requestId = crypto.randomUUID();
        return accept("terminals", { type: "close-terminal", requestId, terminalId }, options);
      },
    },
    vscode: {
      getState: (options) =>
        invoke("vscode", { type: "get-embedded-editor-state" }, options).then((response) => {
          const state = expectResponse(response, "embedded-editor-state-loaded");
          return { status: state.status, message: state.message, customPath: state.customPath };
        }),
      install: (options) => {
        const requestId = crypto.randomUUID();
        return accept("vscode", { type: "install-embedded-editor", requestId }, options);
      },
      setServerPath: (path, options) =>
        invoke("vscode", { type: "set-vscode-server-path", path }, options).then(
          (response) => expectResponse(response, "application-state-updated").state,
        ),
      open: (workingDirectory, options) => {
        const requestId = crypto.randomUUID();
        return accept(
          "vscode",
          { type: "open-embedded-editor", requestId, workspacePath: workingDirectory },
          options,
        );
      },
      updateBounds: (input, options) => {
        const requestId = crypto.randomUUID();
        return accept(
          "vscode",
          { type: "update-embedded-editor-bounds", requestId, ...input },
          options,
        );
      },
      reveal: (workingDirectory, location, options) => {
        const requestId = crypto.randomUUID();
        return accept(
          "vscode",
          {
            type: "reveal-in-embedded-editor",
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
          {
            type: "open-embedded-editor-source-control",
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
          {
            type: "update-embedded-editor-annotations",
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
        invoke(
          "artifacts",
          {
            type: "respond-artifact",
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
        invoke(
          "artifacts",
          {
            type: "respond-ui",
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
        invoke("artifacts", { type: "export-artifacts", sessionId }, options).then(
          (response) => expectResponse(response, "artifacts-exported").markdown,
        ),
    },
    plugins: {
      getCustomizationState: (options) =>
        invoke("plugins", { type: "get-customization-state" }, options).then(
          (response) => expectResponse(response, "customization-state").state,
        ),
      getAuthoringReference: (options) =>
        invoke("plugins", { type: "get-plugin-authoring-reference" }, options).then(
          (response) => expectResponse(response, "plugin-authoring-reference").reference,
        ),
      listFiles: (options) =>
        invoke("plugins", { type: "list-plugin-files" }, options).then((response) =>
          expectResponse(response, "plugin-files"),
        ),
      create: (input, options) =>
        invoke("plugins", { type: "create-plugin", ...input }, options).then((response) =>
          expectResponse(response, "plugin-files"),
        ),
      readFile: (pluginId, path, options) =>
        invoke("plugins", { type: "read-plugin-file", pluginId, path }, options).then(
          (response) => expectResponse(response, "plugin-file").content,
        ),
      writeFile: (pluginId, path, content, expectedWorkingRevision, options) =>
        invoke(
          "plugins",
          { type: "write-plugin-file", pluginId, path, content, expectedWorkingRevision },
          options,
        ).then((response) => expectResponse(response, "plugin-files")),
      validate: (expectedBaseRevision, request, expectedSourceRevision, options) =>
        invoke(
          "plugins",
          { type: "validate-customization", expectedBaseRevision, request, expectedSourceRevision },
          options,
        ).then((response) => expectResponse(response, "customization-validation")),
      activate: (revision, expectedSourceRevision, request, options) =>
        invoke(
          "plugins",
          { type: "activate-customization", revision, expectedSourceRevision, request },
          options,
        ).then((response) => expectResponse(response, "customization-activation")),
      rollback: (options) =>
        invoke("plugins", { type: "rollback-customization" }, options).then(
          (response) => expectResponse(response, "customization-state").state,
        ),
      useFactory: (options) =>
        invoke("plugins", { type: "use-factory-customization" }, options).then(
          (response) => expectResponse(response, "customization-state").state,
        ),
      list: (options) =>
        invoke("plugins", { type: "list-plugins" }, options).then(
          (response) => expectResponse(response, "plugins-listed").plugins,
        ),
      setEnabled: (pluginId, enabled, options) =>
        invoke("plugins", { type: "set-plugin-enabled", pluginId, enabled }, options).then(
          (response) => expectResponse(response, "plugins-listed").plugins,
        ),
      setActiveScene: (pluginId, options) =>
        invoke("plugins", { type: "set-active-scene", pluginId }, options).then(
          (response) => expectResponse(response, "plugins-listed").plugins,
        ),
      delete: (pluginId, options) =>
        invoke("plugins", { type: "delete-plugin", pluginId }, options).then(
          (response) => expectResponse(response, "plugins-listed").plugins,
        ),
      compileInlineWidget: (language, source, capability, options) =>
        invoke(
          "plugins",
          { type: "compile-inline-widget", language, source, capability },
          options,
        ).then((response) => expectResponse(response, "inline-widget-compiled").widget),
      repairInlineWidget: (input, options) =>
        invoke("plugins", { type: "repair-inline-widget", ...input }, options).then(
          (response) => expectResponse(response, "inline-widget-repaired").widget,
        ),
      openAgent: (pluginId, input, implicitSession, options) =>
        invoke(
          "plugins",
          { type: "open-plugin-agent", pluginId, options: input, implicitSession },
          options,
        ).then((response) => expectResponse(response, "plugin-agent-snapshot").snapshot),
      promptAgent: (pluginId, handleId, delivery, text, options) =>
        invoke(
          "plugins",
          { type: "prompt-plugin-agent", pluginId, handleId, delivery, text },
          options,
        ).then((response) => expectResponse(response, "plugin-agent-snapshot").snapshot),
      abortAgent: (pluginId, handleId, options) =>
        invoke("plugins", { type: "abort-plugin-agent", pluginId, handleId }, options).then(
          (response) => expectResponse(response, "plugin-agent-snapshot").snapshot,
        ),
      detachAgent: (pluginId, handleId, options) =>
        invoke("plugins", { type: "detach-plugin-agent", pluginId, handleId }, options).then(
          (response) => {
            expectResponse(response, "plugin-agent-detached");
          },
        ),
      runCompletion: (pluginId, requestId, request, implicitSession, options) =>
        invoke(
          "plugins",
          { type: "run-plugin-completion", pluginId, requestId, request, implicitSession },
          options,
        ).then((response) => expectResponse(response, "plugin-completion-result").result),
      cancelCompletion: (pluginId, requestId, options) =>
        invoke("plugins", { type: "cancel-plugin-completion", pluginId, requestId }, options).then(
          () => undefined,
        ),
      loadState: (pluginId, key, scope, options) =>
        invoke("plugins", { type: "load-plugin-state", pluginId, key, scope }, options).then(
          (response) => expectResponse(response, "plugin-state").record,
        ),
      saveState: (input, options) =>
        invoke("plugins", { type: "save-plugin-state", ...input }, options).then((response) => {
          const record = expectResponse(response, "plugin-state").record;
          if (!record) throw new Error("Cake did not persist plugin state");
          return record;
        }),
      callBackend: (input, options) =>
        invoke("plugins", { type: "call-plugin-backend", ...input }, options).then((response) => {
          const result = expectResponse(response, "plugin-backend-result");
          return { ok: result.ok, value: result.value, error: result.error };
        }),
      cancelBackendCall: (pluginId, callId, options) =>
        invoke("plugins", { type: "cancel-plugin-backend-call", pluginId, callId }, options).then(
          () => undefined,
        ),
      reportRendered: (revision, options) =>
        invoke("plugins", { type: "customization-rendered", revision }, options).then(
          () => undefined,
        ),
      reportRuntimeFailure: (revision, message, options) =>
        invoke(
          "plugins",
          { type: "customization-runtime-failed", revision, message },
          options,
        ).then(() => undefined),
    },
  };
}
