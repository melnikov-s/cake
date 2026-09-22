import type { AppControlHost } from "./AppControlBridge";
import type { Client } from "../client/Client";
import type { AppShellStore } from "../stores/AppShellStore";
import type { ApplicationControlStore } from "../stores/ApplicationControlStore";
import type { CakeChatCollectionStore } from "../stores/CakeChatCollectionStore";
import type { NotificationStore } from "../stores/NotificationStore";
import type { ProjectCatalogStore } from "../stores/ProjectCatalogStore";
import type { ProjectWorkbenchStore } from "../stores/ProjectWorkbenchStore";
import type { SessionCatalogStore } from "../stores/SessionCatalogStore";
import type { SessionCoordinationStore } from "../stores/SessionCoordinationStore";
import type { SessionLayoutStore } from "../stores/SessionLayoutStore";
import type { SessionRegistryStore } from "../stores/SessionRegistryStore";
import type { SettingsStore } from "../stores/SettingsStore";
import type { ToastStore } from "../stores/ToastStore";
import type { SessionActivity } from "../lib/session-activity";
import type { ChatConfiguration } from "../../ipc/session-contract";
import type { WorktreeRecord } from "../../domain/worktrees/managed-worktree-data";
import { defaultProjectSettings } from "../../domain/application/application-data";
import { crossSessionContextSnapshot } from "../../domain/conversations/cross-session-coordination";

export interface RootApplicationControlCapabilities {
  client: Client;
  signal: AbortSignal;
  flushWindowState(): Promise<void>;
  appShellStore: AppShellStore;
  applicationControlStore(): ApplicationControlStore;
  cakeChatCollectionStore: CakeChatCollectionStore;
  notificationStore: NotificationStore;
  projectCatalogStore: ProjectCatalogStore;
  projectWorkbenchStore: ProjectWorkbenchStore;
  sessionCatalogStore: SessionCatalogStore;
  sessionCoordinationStore: SessionCoordinationStore;
  sessionLayoutStore: SessionLayoutStore;
  sessionRegistry: SessionRegistryStore;
  settingsStore: SettingsStore;
  sessionActivity(sessionId: string): SessionActivity | undefined;
  toastStore: ToastStore;
  projectSessionWorkingDirectory(sessionId: string): string | undefined;
  requireProjectSessionWorkingDirectory(sessionId: string): string;
  prepareProjectSessionChat(sessionId: string): Promise<void>;
  openSession(sessionId: string, messageId?: string): Promise<boolean>;
  openCakeChat(sessionId?: string): Promise<void>;
  createPromptedSession(input: {
    workspacePath: string;
    name: string;
    initialPrompt: string;
    model?: ChatConfiguration;
    worktreeName?: string;
    markdown?: boolean;
  }): Promise<{ workspacePath: string; sessionId: string; managedWorktree?: WorktreeRecord }>;
  createDraftSession(input: {
    workspacePath: string;
    name: string;
    initialPrompt: string;
    model?: ChatConfiguration;
  }): Promise<{ workspacePath: string; sessionId: string }>;
  forgetResolvedProjectSessions(sessionIds: readonly string[]): Promise<void>;
  forgetResolvedSessions(sessionIds: readonly string[]): Promise<void>;
  focusCakeChatPane(paneId: string): void;
  focusSessionPane(paneId: string): void;
  splitFocusedCakeChat(axis: "x" | "y"): { paneId: string; sessionId: string } | undefined;
  splitFocusedSession(axis: "x" | "y"): { paneId: string; sessionId: string } | undefined;
}

/** Adapts focused renderer owners to the application-control protocol host. */
export function createRootApplicationControlHost(
  capabilities: RootApplicationControlCapabilities,
): AppControlHost {
  return {
    sessionCoordination: capabilities.sessionCoordinationStore,
    state: {
      currentSelection: () => {
        const selection = capabilities.appShellStore.selection;
        if (selection.kind === "project-session") {
          if (
            capabilities.sessionRegistry.pendingSessions.isTemporary(selection.sessionId) &&
            !capabilities.sessionRegistry.pendingSessions.isDraft(selection.sessionId)
          )
            return { kind: "new-project-chat" as const };
          const summary = capabilities.sessionCatalogStore.find(selection.sessionId);
          const workspacePath =
            capabilities.projectSessionWorkingDirectory(selection.sessionId) ?? "";
          return {
            kind: "project-session" as const,
            sessionId: selection.sessionId,
            title: summary?.title ?? "New chat",
            workspacePath,
            workspaceName:
              summary?.projectName ?? capabilities.projectCatalogStore.nameForPath(workspacePath),
          };
        }
        if (selection.kind === "cake-chat") {
          if (
            !selection.sessionId ||
            (capabilities.cakeChatCollectionStore.pendingSessions.isPending(selection.sessionId) &&
              !capabilities.cakeChatCollectionStore.pendingSessions.conversation(
                selection.sessionId,
              )?.isDraft)
          )
            return { kind: "new-cake-chat" as const };
          return {
            kind: "cake-chat" as const,
            sessionId: selection.sessionId,
            title:
              capabilities.cakeChatCollectionStore.summaries.find(
                (session) => session.sessionId === selection.sessionId,
              )?.title ?? "Cake Chat",
          };
        }
        if (selection.kind === "settings")
          return { kind: "settings" as const, page: capabilities.settingsStore.activePage };
        return { kind: "workbench" as const };
      },
      sessionLayout: (source) => {
        const layout =
          source?.kind === "cake-chat"
            ? capabilities.cakeChatCollectionStore.sessionLayoutStore
            : capabilities.sessionLayoutStore;
        const relativeSessionId =
          source?.sessionId && layout.hasSession(source.sessionId)
            ? source.sessionId
            : layout.focusedSessionId;
        return {
          focusedSessionId: layout.focusedSessionId,
          ...(relativeSessionId ? { originSessionId: relativeSessionId } : null),
          panes: layout.panePlacements.map((pane) => ({ ...pane })),
          ...(relativeSessionId ? { neighbors: layout.neighbors(relativeSessionId) } : null),
        };
      },
      projects: () => capabilities.projectCatalogStore.projects,
      sessions: () => capabilities.sessionCatalogStore.sessions,
      cakeChatSessions: () => capabilities.cakeChatCollectionStore.summaries,
      sessionActivity: capabilities.sessionActivity,
      managedWorktree: (workingDirectory) =>
        capabilities.sessionCatalogStore.managedWorktree(workingDirectory),
      globalSessionLabels: () => capabilities.settingsStore.globalLabels.labels,
    },
    settings: {
      get: (section) => capabilities.settingsStore.settingsSection(section),
      update: async (input) => {
        const view = capabilities.settingsStore.updateSettings(input);
        await capabilities.flushWindowState();
        return view;
      },
    },
    projectSettings: {
      get: (projectPath) => capabilities.projectCatalogStore.find(projectPath)?.settings,
      update: (projectPath, changes) =>
        capabilities.applicationControlStore().runOperation(async () => {
          const current =
            capabilities.projectCatalogStore.find(projectPath)?.settings ??
            defaultProjectSettings();
          const settings = { ...current, ...changes };
          await capabilities.client.workspaces.setProjectSettings(projectPath, settings, {
            signal: capabilities.signal,
          });
          return settings;
        }),
    },
    vscode: {
      enter: (source) => capabilities.projectWorkbenchStore.showSessionEditor(source.sessionId),
      open: (source, location) =>
        capabilities.projectWorkbenchStore.showSessionEditor(source.sessionId, location),
      performEditorAction: (source, action) =>
        capabilities.client.vscode.performEditorAction(
          capabilities.requireProjectSessionWorkingDirectory(source.sessionId),
          action,
          { signal: capabilities.signal },
        ),
    },
    sessionLabels: {
      mutate: ({ projectPath }, mutation) =>
        capabilities.applicationControlStore().runOperation(async () => {
          if (projectPath)
            await capabilities.client.projectWorkflow.mutate(
              { projectPath, mutation },
              { signal: capabilities.signal },
            );
          else
            await capabilities.client.projectWorkflow.mutateGlobal(
              { mutation },
              { signal: capabilities.signal },
            );
        }),
      setSessionLabels: (sessionId, labelIds) =>
        capabilities.projectWorkbenchStore.sessionManagementStore.setSessionLabels(
          sessionId,
          labelIds,
        ),
    },
    worktrees: {
      merge: async ({ sessionId, workingDirectory }) => {
        const operationId = crypto.randomUUID();
        await capabilities.client.managedWorktrees.startLanding(
          {
            operationId,
            workspacePath: workingDirectory,
            sessionId,
            strategy: "preserve",
            allowDirtyTarget: false,
            commitBeforeLanding: true,
            resolveAfterLanding: false,
          },
          { signal: capabilities.signal },
        );
        return operationId;
      },
      discard: async ({ workingDirectory, keepBranch }) => {
        await capabilities.client.managedWorktrees.discard(
          {
            operationId: crypto.randomUUID(),
            workspacePath: workingDirectory,
            keepBranch,
          },
          { signal: capabilities.signal },
        );
      },
    },
    sessions: {
      contextSnapshot: (sessionId) => {
        const model =
          capabilities.sessionRegistry.findSession(sessionId)?.model ??
          capabilities.cakeChatCollectionStore.registry.find(sessionId)?.model;
        return crossSessionContextSnapshot(model?.usage?.context);
      },
      inspect: (sessionId) =>
        capabilities.client.projectSessions.inspect({ sessionId }, { signal: capabilities.signal }),
      open: (sessionId, messageId) => capabilities.openSession(sessionId, messageId),
      create: (input) => capabilities.createPromptedSession(input),
      createDraft: (input) => capabilities.createDraftSession(input),
      sendMessage: (sessionId, text, delivery, crossSession) =>
        capabilities.applicationControlStore().runOperation(async () => {
          await capabilities.prepareProjectSessionChat(sessionId);
          const command =
            delivery === "steer"
              ? capabilities.client.sessionChats.steer
              : delivery === "follow-up"
                ? capabilities.client.sessionChats.followUp
                : capabilities.client.sessionChats.prompt;
          return command(
            {
              sessionId,
              text,
              renderUserMessageAsMarkdown: false,
              attachments: [],
              ...(crossSession ? { crossSession } : null),
            },
            { signal: capabilities.signal },
          );
        }),
      compact: (sessionId, instructions) =>
        capabilities.applicationControlStore().runOperation(async () => {
          await capabilities.prepareProjectSessionChat(sessionId);
          return capabilities.client.sessionChats.compact(
            { sessionId, instructions },
            { signal: capabilities.signal },
          );
        }),
      scheduleMessage: (input) =>
        capabilities
          .applicationControlStore()
          .runOperation(() =>
            capabilities.client.scheduledMessages.schedule(input, { signal: capabilities.signal }),
          ),
      listScheduledMessages: (sessionId) =>
        capabilities.client.scheduledMessages.list(sessionId, { signal: capabilities.signal }),
      cancelScheduledMessage: (id) =>
        capabilities
          .applicationControlStore()
          .runOperation(() =>
            capabilities.client.scheduledMessages.cancel(id, { signal: capabilities.signal }),
          ),
      listPendingMessages: async (sessionId) => {
        await capabilities.prepareProjectSessionChat(sessionId);
        return capabilities.client.sessionChats.listQueuedMessages(
          { sessionId },
          { signal: capabilities.signal },
        );
      },
      dequeuePendingMessages: (sessionId) =>
        capabilities.applicationControlStore().runOperation(async () => {
          await capabilities.prepareProjectSessionChat(sessionId);
          return capabilities.client.sessionChats.clearQueue(
            { sessionId },
            { signal: capabilities.signal },
          );
        }),
      abort: (sessionId) =>
        capabilities.applicationControlStore().runOperation(async () => {
          await capabilities.prepareProjectSessionChat(sessionId);
          return capabilities.client.sessionChats.abort(
            { sessionId },
            { signal: capabilities.signal },
          );
        }),
      rename: (sessionId, title) =>
        capabilities.cakeChatCollectionStore.summaries.some(
          (session) => session.sessionId === sessionId,
        )
          ? capabilities.cakeChatCollectionStore.management
              .renameSession(sessionId, title)
              .then(() => undefined)
          : capabilities.projectWorkbenchStore.sessionManagementStore.renameSession(
              sessionId,
              title,
            ),
      setProjectSessionsResolved: async (sessionIds, resolved) => {
        const count =
          await capabilities.projectWorkbenchStore.sessionManagementStore.resolveSessionsById(
            sessionIds,
            resolved,
          );
        if (resolved && count === sessionIds.length)
          await capabilities.forgetResolvedProjectSessions(sessionIds);
        return count;
      },
      setCakeChatSessionsResolved: async (sessionIds, resolved) => {
        const count = await capabilities.cakeChatCollectionStore.management.resolveSessions(
          sessionIds,
          resolved,
        );
        if (resolved) await capabilities.forgetResolvedSessions(sessionIds);
        return count;
      },
    },
    presentation: {
      splitView: (source, direction) => {
        const axis = direction === "right" ? "x" : "y";
        if (source.kind === "cake-chat") {
          const pane = capabilities.cakeChatCollectionStore.sessionLayoutStore.paneForSession(
            source.sessionId,
          );
          if (!pane) return undefined;
          capabilities.focusCakeChatPane(pane.paneId);
          const split = capabilities.splitFocusedCakeChat(axis);
          return split ? { kind: source.kind, ...split } : undefined;
        }
        const pane = capabilities.sessionLayoutStore.paneForSession(source.sessionId);
        if (!pane) return undefined;
        capabilities.focusSessionPane(pane.paneId);
        const split = capabilities.splitFocusedSession(axis);
        return split ? { kind: source.kind, ...split } : undefined;
      },
      showNotification: (input) => capabilities.notificationStore.enqueue(input),
      showAgentAction: ({ source, message, targetSessionId, targetKind, coalesceKey }) => {
        const action =
          targetSessionId && targetKind
            ? {
                label: "View",
                run: async () => {
                  if (targetKind === "cake-chat") await capabilities.openCakeChat(targetSessionId);
                  else await capabilities.openSession(targetSessionId);
                },
              }
            : undefined;
        capabilities.toastStore.show({
          title: `Agent action · ${source.title}`,
          message,
          action,
          coalesceKey: `agent:${source.sessionId}:${coalesceKey}`,
        });
      },
    },
  };
}
