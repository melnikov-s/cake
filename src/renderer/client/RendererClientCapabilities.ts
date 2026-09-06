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
  | "inlineWidgets"
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
      showNotification: (input, options) =>
        execute(
          "electron.show-notification",
          (client) => client.electron["show-notification"]({ ...input }),
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
      loadStagedSlashCommands: (path, options) =>
        execute(
          "workspaces.load-staged-slash-commands",
          (client) => client.workspaces["load-staged-slash-commands"]({ path }),
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
      setProjectSettings: (path, settings, options) =>
        execute(
          "workspaces.set-project-settings",
          (client) => client.workspaces["set-project-settings"]({ path, settings }),
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
      prepareLanding: (input, options) =>
        accepted(
          "managedWorktrees.prepare-worktree-landing",
          (client) =>
            client.managedWorktrees["prepare-worktree-landing"]({
              requestId: input.operationId,
              workspacePath: input.workspacePath,
            }),
          input.operationId,
          options,
        ),
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
      cancelLanding: (input, options) => {
        const requestId = crypto.randomUUID();
        return accepted(
          "managedWorktrees.cancel-worktree-landing",
          (client) =>
            client.managedWorktrees["cancel-worktree-landing"]({
              requestId,
              workspacePath: input.workspacePath,
              landingOperationId: input.operationId,
            }),
          requestId,
          options,
        );
      },
      rebase: (input, options) =>
        execute(
          "managedWorktrees.rebase-worktree",
          (client) =>
            client.managedWorktrees["rebase-worktree"]({
              requestId: input.operationId,
              workspacePath: input.workspacePath,
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
      workingDirectoryStatus: (workingDirectory, options) => {
        const requestId = crypto.randomUUID();
        return execute(
          "terminals.get-terminal-status",
          (client) => client.terminals["get-terminal-status"]({ requestId, workingDirectory }),
          options,
        ).then((response) => {
          const status = response;
          if (status.requestId !== requestId) throw new Error("Cake returned the wrong terminal");
          return { runningProgramCount: status.runningProgramCount };
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
      closeWorkingDirectory: (workingDirectory, options) => {
        const requestId = crypto.randomUUID();
        return accepted(
          "terminals.close-working-directory-terminals",
          (client) =>
            client.terminals["close-working-directory-terminals"]({
              requestId,
              workingDirectory,
            }),
          requestId,
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
    inlineWidgets: {
      compile: (language, source, capability, options) =>
        execute(
          "widgets.compile-inline-widget",
          (client) => client.widgets["compile-inline-widget"]({ language, source, capability }),
          options,
        ).then((response) => response.widget),
      repair: (input, options) =>
        execute(
          "widgets.repair-inline-widget",
          (client) => client.widgets["repair-inline-widget"]({ ...input }),
          options,
        ).then((response) => response.widget),
    },
  };
}
