import type { Effect } from "effect";
import type { CakeIpcClientService } from "../../ipc/client/CakeIpcClient";
import type { RendererClient, RendererCommandOptions } from "./RendererClient";

type Execute = <Success, Failure>(
  operation: string,
  command: (client: CakeIpcClientService) => Effect.Effect<Success, Failure>,
  options?: RendererCommandOptions,
) => Promise<Success>;

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

export function makeRendererClientCapabilities(execute: Execute): RendererClientCapabilities {
  const accepted = async (
    operation: string,
    command: (
      client: CakeIpcClientService,
    ) => Effect.Effect<{ readonly requestId: string }, unknown>,
    requestId: string,
    options: RendererCommandOptions | undefined,
  ) => {
    const response = await execute(operation, command, options);
    if (response.requestId !== requestId)
      throw new Error(`Cake returned the wrong acceptance for ${operation}`);
  };

  return {
    electron: {
      chooseProject: (options) =>
        execute(
          "electron.choose-project",
          (client) => client.electron["choose-project"]({}),
          options,
        ).then((response) => response.path),
      openExternalUrl: (url, options) =>
        execute(
          "electron.open-external-url",
          (client) => client.electron["open-external-url"]({ url }),
          options,
        ).then(() => undefined),
      showTranscriptSelectionContextMenu: (input, options) =>
        execute(
          "electron.show-transcript-selection-context-menu",
          (client) => client.electron["show-transcript-selection-context-menu"]({ ...input }),
          options,
        ).then((response) => response.action),
      showComposerContextMenu: (input, options) =>
        execute(
          "electron.show-composer-context-menu",
          (client) => client.electron["show-composer-context-menu"]({ ...input }),
          options,
        ).then((response) => response.action),
      showSessionContextMenu: (input, options) =>
        execute(
          "electron.show-session-context-menu",
          (client) => client.electron["show-session-context-menu"]({ ...input }),
          options,
        ).then((response) => response.action),
      showProjectContextMenu: (input, options) =>
        execute(
          "electron.show-project-context-menu",
          (client) => client.electron["show-project-context-menu"]({ ...input }),
          options,
        ).then((response) => response.action),
      setFullscreenSurfaceOpen: (surfaceId, open, options) => {
        const requestId = crypto.randomUUID();
        return accepted(
          "electron.set-fullscreen-surface-open",
          (client) =>
            client.electron["set-fullscreen-surface-open"]({ requestId, surfaceId, open }),
          { requestId, surfaceId, open }.requestId,
          options,
        );
      },
    },
    filesystem: {
      chooseAttachments: (options) =>
        execute(
          "filesystem.choose-attachments",
          (client) => client.filesystem["choose-attachments"]({}),
          options,
        ).then((response) => response.attachments),
      suggestFiles: (workingDirectory, prefix, options) =>
        execute(
          "filesystem.suggest-files",
          (client) =>
            client.filesystem["suggest-files"]({ workspacePath: workingDirectory, prefix }),
          options,
        ).then((response) => response.suggestions),
      readFile: (workingDirectory, path, options) =>
        execute(
          "filesystem.read-workspace-file",
          (client) =>
            client.filesystem["read-workspace-file"]({ workspacePath: workingDirectory, path }),
          options,
        ).then((response) => response.content),
    },
    workspaces: {
      rewordComposerSelection: (input, options) =>
        execute(
          "workspaces.reword-composer-selection",
          (client) =>
            client.workspaces["reword-composer-selection"]({
              selection: input.selection,
              prompt: input.prompt,
              workspacePath: input.workingDirectory,
            }),
          options,
        ).then((response) => response.text),
      generateSessionTitle: (firstUserMessage, options) =>
        execute(
          "workspaces.generate-session-title",
          (client) => client.workspaces["generate-session-title"]({ firstUserMessage }),
          options,
        ).then((response) => response.title),
      setUtilityModel: (model, options) =>
        execute(
          "workspaces.set-utility-model",
          (client) => client.workspaces["set-utility-model"]({ model }),
          options,
        ).then((response) => response.state),
      loadSlashCommands: (path, options) =>
        execute(
          "workspaces.load-slash-commands",
          (client) => client.workspaces["load-slash-commands"]({ path }),
          options,
        ).then((response) => response.commands),
      registerProject: (path, name, options) =>
        execute(
          "workspaces.register-project",
          (client) => client.workspaces["register-project"]({ path, name }),
          options,
        ).then((response) => response.state),
      renameProject: (path, name, options) =>
        execute(
          "workspaces.rename-project",
          (client) => client.workspaces["rename-project"]({ path, name }),
          options,
        ).then((response) => response.state),
      removeProject: (path, deleteSessions, options) =>
        execute(
          "workspaces.remove-project",
          (client) => client.workspaces["remove-project"]({ path, deleteSessions }),
          options,
        ).then((response) => response.state),
      deleteSession: (sessionId, options) =>
        execute(
          "workspaces.delete-session",
          (client) => client.workspaces["delete-session"]({ sessionId }),
          options,
        ).then((response) => response.state),
      setSessionUnread: (sessionId, unread, options) =>
        execute(
          "workspaces.set-session-unread",
          (client) => client.workspaces["set-session-unread"]({ sessionId, unread }),
          options,
        ).then((response) => response.state),
      restartPi: (path, options) =>
        execute(
          "workspaces.restart-pi",
          (client) => client.workspaces["restart-pi"]({ path }),
          options,
        ).then(() => undefined),
      inspect: (input, options) =>
        accepted(
          "workspaces.inspect-workspace",
          (client) =>
            client.workspaces["inspect-workspace"]({
              requestId: input.operationId,
              path: input.path,
            }),
          { requestId: input.operationId, path: input.path }.requestId,
          options,
        ),
      respondToTrust: (input, options) =>
        accepted(
          "workspaces.respond-workspace-trust",
          (client) =>
            client.workspaces["respond-workspace-trust"]({
              requestId: input.operationId,
              path: input.path,
              approved: input.approved,
            }),
          {
            requestId: input.operationId,
            path: input.path,
            approved: input.approved,
          }.requestId,
          options,
        ),
    },
    managedWorktrees: {
      create: (input, options) =>
        execute(
          "managedWorktrees.create-worktree",
          (client) =>
            client.managedWorktrees["create-worktree"]({
              requestId: input.operationId,
              path: input.path,
              baseWorktreePath: input.baseWorktreePath,
              worktreeName: input.worktreeName,
              firstUserMessage: input.firstUserMessage,
            }),
          options,
        ).then((response) => response.record),
      status: (input, options) =>
        execute(
          "managedWorktrees.get-worktree-status",
          (client) => client.managedWorktrees["get-worktree-status"]({ ...input }),
          options,
        ).then((response) => response.status),
      land: (input, options) =>
        execute(
          "managedWorktrees.land-worktree",
          (client) =>
            client.managedWorktrees["land-worktree"]({
              requestId: input.operationId,
              workspacePath: input.workspacePath,
              request: input.request,
            }),
          options,
        ).then((response) => response.result),
      discard: (input, options) =>
        accepted(
          "managedWorktrees.discard-worktree",
          (client) =>
            client.managedWorktrees["discard-worktree"]({
              requestId: input.operationId,
              workspacePath: input.workspacePath,
              keepBranch: input.keepBranch,
            }),
          {
            requestId: input.operationId,
            workspacePath: input.workspacePath,
            keepBranch: input.keepBranch,
          }.requestId,
          options,
        ),
    },
    terminals: {
      open: (input, options) => {
        const requestId = crypto.randomUUID();
        return execute(
          "terminals.open-terminal",
          (client) => client.terminals["open-terminal"]({ requestId, ...input }),
          options,
        ).then((response) => {
          const opened = response;
          if (opened.requestId !== requestId) throw new Error("Cake returned the wrong terminal");
          return { terminalId: opened.terminalId, shell: opened.shell };
        });
      },
      write: (terminalId, data, options) => {
        const requestId = crypto.randomUUID();
        return accepted(
          "terminals.write-terminal",
          (client) => client.terminals["write-terminal"]({ requestId, terminalId, data }),
          { requestId, terminalId, data }.requestId,
          options,
        );
      },
      resize: (terminalId, cols, rows, options) => {
        const requestId = crypto.randomUUID();
        return accepted(
          "terminals.resize-terminal",
          (client) => client.terminals["resize-terminal"]({ requestId, terminalId, cols, rows }),
          { requestId, terminalId, cols, rows }.requestId,
          options,
        );
      },
      status: (terminalId, options) => {
        const requestId = crypto.randomUUID();
        return execute(
          "terminals.get-terminal-status",
          (client) => client.terminals["get-terminal-status"]({ requestId, terminalId }),
          options,
        ).then((response) => {
          const status = response;
          if (status.requestId !== requestId) throw new Error("Cake returned the wrong terminal");
          return { runningProgram: status.runningProgram };
        });
      },
      close: (terminalId, options) => {
        const requestId = crypto.randomUUID();
        return accepted(
          "terminals.close-terminal",
          (client) => client.terminals["close-terminal"]({ requestId, terminalId }),
          { requestId, terminalId }.requestId,
          options,
        );
      },
    },
    vscode: {
      getState: (options) =>
        execute(
          "vscode.get-embedded-editor-state",
          (client) => client.vscode["get-embedded-editor-state"]({}),
          options,
        ).then((response) => {
          const state = response;
          return { status: state.status, message: state.message, customPath: state.customPath };
        }),
      install: (options) => {
        const requestId = crypto.randomUUID();
        return accepted(
          "vscode.install-embedded-editor",
          (client) => client.vscode["install-embedded-editor"]({ requestId }),
          { requestId }.requestId,
          options,
        );
      },
      setServerPath: (path, options) =>
        execute(
          "vscode.set-vscode-server-path",
          (client) => client.vscode["set-vscode-server-path"]({ path }),
          options,
        ).then((response) => response.state),
      open: (workingDirectory, options) => {
        const requestId = crypto.randomUUID();
        return accepted(
          "vscode.open-embedded-editor",
          (client) =>
            client.vscode["open-embedded-editor"]({ requestId, workspacePath: workingDirectory }),
          { requestId, workspacePath: workingDirectory }.requestId,
          options,
        );
      },
      updateBounds: (input, options) => {
        const requestId = crypto.randomUUID();
        return accepted(
          "vscode.update-embedded-editor-bounds",
          (client) => client.vscode["update-embedded-editor-bounds"]({ requestId, ...input }),
          { requestId, ...input }.requestId,
          options,
        );
      },
      reveal: (workingDirectory, location, options) => {
        const requestId = crypto.randomUUID();
        return accepted(
          "vscode.reveal-in-embedded-editor",
          (client) =>
            client.vscode["reveal-in-embedded-editor"]({
              requestId,
              workspacePath: workingDirectory,
              location,
            }),
          {
            requestId,
            workspacePath: workingDirectory,
            location,
          }.requestId,
          options,
        );
      },
      openSourceControl: (workingDirectory, options) => {
        const requestId = crypto.randomUUID();
        return accepted(
          "vscode.open-embedded-editor-source-control",
          (client) =>
            client.vscode["open-embedded-editor-source-control"]({
              requestId,
              workspacePath: workingDirectory,
            }),
          {
            requestId,
            workspacePath: workingDirectory,
          }.requestId,
          options,
        );
      },
      updateAnnotations: (workingDirectory, snapshot, options) => {
        const requestId = crypto.randomUUID();
        return accepted(
          "vscode.update-embedded-editor-annotations",
          (client) =>
            client.vscode["update-embedded-editor-annotations"]({
              requestId,
              workspacePath: workingDirectory,
              snapshot,
            }),
          {
            requestId,
            workspacePath: workingDirectory,
            snapshot,
          }.requestId,
          options,
        );
      },
    },
    artifacts: {
      respond: (input, options) =>
        execute(
          "artifacts.respond-artifact",
          (client) =>
            client.artifacts["respond-artifact"]({
              requestId: input.operationId,
              sessionId: input.sessionId,
              artifactRequestId: input.artifactRequestId,
              value: input.value,
              cancelled: input.cancelled,
            }),
          options,
        ).then(() => undefined),
      respondToUi: (input, options) =>
        execute(
          "artifacts.respond-ui",
          (client) =>
            client.artifacts["respond-ui"]({
              requestId: input.operationId,
              sessionId: input.sessionId,
              uiRequestId: input.uiRequestId,
              value: input.value,
              cancelled: input.cancelled,
            }),
          options,
        ).then(() => undefined),
      export: (sessionId, options) =>
        execute(
          "artifacts.export-artifacts",
          (client) => client.artifacts["export-artifacts"]({ sessionId }),
          options,
        ).then((response) => response.markdown),
    },
    plugins: {
      getCustomizationState: (options) =>
        execute(
          "plugins.get-customization-state",
          (client) => client.plugins["get-customization-state"]({}),
          options,
        ).then((response) => response.state),
      getAuthoringReference: (options) =>
        execute(
          "plugins.get-plugin-authoring-reference",
          (client) => client.plugins["get-plugin-authoring-reference"]({}),
          options,
        ).then((response) => response.reference),
      listFiles: (options) =>
        execute(
          "plugins.list-plugin-files",
          (client) => client.plugins["list-plugin-files"]({}),
          options,
        ).then((response) => response),
      create: (input, options) =>
        execute(
          "plugins.create-plugin",
          (client) => client.plugins["create-plugin"]({ ...input }),
          options,
        ).then((response) => response),
      readFile: (pluginId, path, options) =>
        execute(
          "plugins.read-plugin-file",
          (client) => client.plugins["read-plugin-file"]({ pluginId, path }),
          options,
        ).then((response) => response.content),
      writeFile: (pluginId, path, content, expectedWorkingRevision, options) =>
        execute(
          "plugins.write-plugin-file",
          (client) =>
            client.plugins["write-plugin-file"]({
              pluginId,
              path,
              content,
              expectedWorkingRevision,
            }),
          options,
        ).then((response) => response),
      validate: (expectedBaseRevision, request, expectedSourceRevision, options) =>
        execute(
          "plugins.validate-customization",
          (client) =>
            client.plugins["validate-customization"]({
              expectedBaseRevision,
              request,
              expectedSourceRevision,
            }),
          options,
        ).then((response) => response),
      activate: (revision, expectedSourceRevision, request, options) =>
        execute(
          "plugins.activate-customization",
          (client) =>
            client.plugins["activate-customization"]({ revision, expectedSourceRevision, request }),
          options,
        ).then((response) => response),
      rollback: (options) =>
        execute(
          "plugins.rollback-customization",
          (client) => client.plugins["rollback-customization"]({}),
          options,
        ).then((response) => response.state),
      useFactory: (options) =>
        execute(
          "plugins.use-factory-customization",
          (client) => client.plugins["use-factory-customization"]({}),
          options,
        ).then((response) => response.state),
      list: (options) =>
        execute(
          "plugins.list-plugins",
          (client) => client.plugins["list-plugins"]({}),
          options,
        ).then((response) => response.plugins),
      setEnabled: (pluginId, enabled, options) =>
        execute(
          "plugins.set-plugin-enabled",
          (client) => client.plugins["set-plugin-enabled"]({ pluginId, enabled }),
          options,
        ).then((response) => response.plugins),
      setActiveScene: (pluginId, options) =>
        execute(
          "plugins.set-active-scene",
          (client) => client.plugins["set-active-scene"]({ pluginId }),
          options,
        ).then((response) => response.plugins),
      delete: (pluginId, options) =>
        execute(
          "plugins.delete-plugin",
          (client) => client.plugins["delete-plugin"]({ pluginId }),
          options,
        ).then((response) => response.plugins),
      compileInlineWidget: (language, source, capability, options) =>
        execute(
          "plugins.compile-inline-widget",
          (client) => client.plugins["compile-inline-widget"]({ language, source, capability }),
          options,
        ).then((response) => response.widget),
      repairInlineWidget: (input, options) =>
        execute(
          "plugins.repair-inline-widget",
          (client) => client.plugins["repair-inline-widget"]({ ...input }),
          options,
        ).then((response) => response.widget),
      openAgent: (pluginId, input, implicitSession, options) =>
        execute(
          "plugins.open-plugin-agent",
          (client) =>
            client.plugins["open-plugin-agent"]({ pluginId, options: input, implicitSession }),
          options,
        ).then((response) => response.snapshot),
      promptAgent: (pluginId, handleId, delivery, text, options) =>
        execute(
          "plugins.prompt-plugin-agent",
          (client) => client.plugins["prompt-plugin-agent"]({ pluginId, handleId, delivery, text }),
          options,
        ).then((response) => response.snapshot),
      abortAgent: (pluginId, handleId, options) =>
        execute(
          "plugins.abort-plugin-agent",
          (client) => client.plugins["abort-plugin-agent"]({ pluginId, handleId }),
          options,
        ).then((response) => response.snapshot),
      detachAgent: (pluginId, handleId, options) =>
        execute(
          "plugins.detach-plugin-agent",
          (client) => client.plugins["detach-plugin-agent"]({ pluginId, handleId }),
          options,
        ).then(() => undefined),
      runCompletion: (pluginId, requestId, request, implicitSession, options) =>
        execute(
          "plugins.run-plugin-completion",
          (client) =>
            client.plugins["run-plugin-completion"]({
              pluginId,
              requestId,
              request,
              implicitSession,
            }),
          options,
        ).then((response) => response.result),
      cancelCompletion: (pluginId, requestId, options) =>
        execute(
          "plugins.cancel-plugin-completion",
          (client) => client.plugins["cancel-plugin-completion"]({ pluginId, requestId }),
          options,
        ).then(() => undefined),
      loadState: (pluginId, key, scope, options) =>
        execute(
          "plugins.load-plugin-state",
          (client) => client.plugins["load-plugin-state"]({ pluginId, key, scope }),
          options,
        ).then((response) => response.record),
      saveState: (input, options) =>
        execute(
          "plugins.save-plugin-state",
          (client) => client.plugins["save-plugin-state"]({ ...input }),
          options,
        ).then((response) => {
          const record = response.record;
          if (!record) throw new Error("Cake did not persist plugin state");
          return record;
        }),
      callBackend: (input, options) =>
        execute(
          "plugins.call-plugin-backend",
          (client) => client.plugins["call-plugin-backend"]({ ...input }),
          options,
        ).then((response) => {
          const result = response;
          return { ok: result.ok, value: result.value, error: result.error };
        }),
      cancelBackendCall: (pluginId, callId, options) =>
        execute(
          "plugins.cancel-plugin-backend-call",
          (client) => client.plugins["cancel-plugin-backend-call"]({ pluginId, callId }),
          options,
        ).then(() => undefined),
      reportRendered: (revision, options) =>
        execute(
          "plugins.customization-rendered",
          (client) => client.plugins["customization-rendered"]({ revision }),
          options,
        ).then(() => undefined),
      reportRuntimeFailure: (revision, message, options) =>
        execute(
          "plugins.customization-runtime-failed",
          (client) => client.plugins["customization-runtime-failed"]({ revision, message }),
          options,
        ).then(() => undefined),
    },
  };
}
