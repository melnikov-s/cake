import {
  type SessionInspectionQuery,
  type QueuedSessionCommandReceipt,
} from "../../contracts/conversations/session-query-data";
import type {
  AgentSettingsInvocation,
  agentSettingsSections,
} from "../../contracts/application/agent-settings-schema";
import { type JsonValue, type JsonObject } from "../../contracts/serialization/json-contract";
import {
  type ChatConfiguration,
  type ProjectRecord,
} from "../../contracts/conversations/session-contract";
import { type CakeChatSummary } from "../../contracts/cake-chats/cake-chat-data";
import type { SessionSummary } from "../models/SessionSummary";
import type { WorktreeRecord } from "../../contracts/worktrees/managed-worktree-data";
import type { ProjectSessionPreview } from "../../contracts/project-sessions/project-session-data";
import type { ScheduledMessage } from "../../contracts/scheduled-messages/scheduled-message-data";
import { type EditorLocation } from "../../contracts/editor/editor-location";
import type { VscodeEditorAction } from "../../contracts/vscode/vscode-editor-action";
import type {
  EditorSelectionId,
  EditorSelectionOpenResult,
  EditorSelectionState,
  EditorSelectionUpdate,
} from "../../contracts/editor/editor-selection";
import type {
  CoordinationMessage,
  CoordinationThread,
  CrossSessionDeliveryStatus,
} from "../../contracts/conversations/cross-session-coordination";
import type {
  CrossSessionMessageMetadata,
  CrossSessionContextSnapshot,
  CrossSessionQueueSnapshot,
} from "../../contracts/conversations/cross-session-message";
import type { QueuedConversationMessages } from "../../contracts/conversations/conversation-data";
import { type SessionActivity } from "../lib/session-activity";
import type { LaunchedSessionStatus } from "../lib/cake-chat-launches";
import type { CakeChatReportPolicy } from "../../contracts/project-sessions/session-reporting";
import {
  type CakeSettingsSectionId,
  type CakeSettingsSectionView,
  type CakeSettingsUpdate,
} from "../../contracts/application/cake-settings-data";
import {
  type ProjectSettings,
  type SessionLabel,
  type SessionLabelMutation,
} from "../../contracts/application/application-data";
import { type ProjectSettingsChanges } from "../../contracts/projects/project-settings-schema";

export type SessionSummaryView = Pick<
  SessionSummary,
  | "workingDirectory"
  | "projectName"
  | "sessionId"
  | "title"
  | "modifiedAt"
  | "messageCount"
  | "resolved"
  | "draft"
> &
  Partial<
    Pick<
      SessionSummary,
      | "projectPath"
      | "familyId"
      | "familyParentSessionId"
      | "familyChildSessionIds"
      | "familyChildOrder"
      | "familyDepth"
      | "running"
      | "cakeChatLaunch"
    >
  >;

type AppControlSelection =
  | { kind: "workbench" }
  | { kind: "new-project-chat" }
  | {
      kind: "project-session";
      workspacePath: string;
      workspaceName: string;
      sessionId: string;
      title: string;
    }
  | { kind: "new-cake-chat" }
  | { kind: "cake-chat"; sessionId: string; title: string }
  | { kind: "settings"; page: string };

export interface AgentControlSource {
  kind: "project-session" | "cake-chat";
  sessionId: string;
  title: string;
  projectName?: string;
  workingDirectory?: string;
  projectPath?: string;
}

export interface AgentActionReceipt {
  message: string;
  targetSessionId?: string;
  targetKind?: "project-session" | "cake-chat";
  coalesceKey: string;
}

interface SessionCoordinationHost {
  create(
    sourceSessionId: string,
    targetSessionId: string,
    maxMessages?: number,
  ): CoordinationThread;
  get(threadId: string): CoordinationThread | undefined;
  find(sessionId: string, explicitThreadId?: string): CoordinationThread | undefined;
  record(thread: CoordinationThread, message: CoordinationMessage): void;
  refresh(thread: CoordinationThread): void;
  close(thread: CoordinationThread): void;
}

/**
 * Session-local selection authority exposed through the application-control bridge.
 * RootApplicationControlHost resolves source.sessionId to that ProjectSessionStore's
 * EditorSelectionsStore. Never target whichever session happens to be focused.
 * An unavailable source Store is an error, not a fallback to main-owned state.
 */
interface AppControlVscodeSelectionsHost {
  open(source: AgentControlSource, location: EditorLocation): Promise<EditorSelectionOpenResult>;
  listSelections(source: AgentControlSource): EditorSelectionState;
  removeSelection(
    source: AgentControlSource,
    id: EditorSelectionId,
  ): Promise<EditorSelectionUpdate>;
  clearSelections(source: AgentControlSource): Promise<EditorSelectionUpdate>;
}

export interface AppControlHost {
  sessionCoordination: SessionCoordinationHost;
  state: {
    currentSelection(): AppControlSelection;
    userSelection(): string | null;
    sessionLayout?(source?: AgentControlSource): {
      focusedSessionId?: string;
      originSessionId?: string;
      panes: Array<{
        paneId: string;
        sessionId: string;
        number: number;
        focused: boolean;
        x: number;
        y: number;
        width: number;
        height: number;
      }>;
      neighbors?: Record<
        "left" | "right" | "above" | "below",
        Array<{ paneId: string; sessionId: string }>
      >;
    };
    projects(): readonly ProjectRecord[];
    sessions(): readonly SessionSummaryView[];
    cakeChatSessions(): readonly CakeChatSummary[];
    sessionActivity(sessionId: string): SessionActivity | undefined;
    managedWorktree(workingDirectory: string): WorktreeRecord | undefined;
    globalSessionLabels(): readonly SessionLabel[];
  };
  agentSettings: {
    invoke(invocation: AgentSettingsInvocation, source?: AgentControlSource): Promise<JsonValue>;
  };
  settings: {
    get(section: CakeSettingsSectionId): CakeSettingsSectionView;
    update(input: CakeSettingsUpdate): Promise<CakeSettingsSectionView>;
  };
  projectSettings: {
    get(projectPath: string): ProjectSettings | undefined;
    update(projectPath: string, changes: ProjectSettingsChanges): Promise<ProjectSettings>;
  };
  sessionLabels: {
    mutate(scope: { projectPath?: string }, mutation: SessionLabelMutation): Promise<void>;
    setSessionLabels(sessionId: string, labelIds: readonly string[]): Promise<boolean>;
  };
  vscode: AppControlVscodeSelectionsHost & {
    enter(source: AgentControlSource): Promise<void>;
    performEditorAction(source: AgentControlSource, action: VscodeEditorAction): Promise<JsonValue>;
  };
  worktrees?: {
    merge(input: { sessionId: string; workingDirectory: string }): Promise<string>;
    discard(input: {
      sessionId: string;
      workingDirectory: string;
      keepBranch: boolean;
    }): Promise<void>;
  };
  sessions: {
    lookup(sessionId: string): Promise<SessionSummaryView | undefined>;
    inspect(sessionId: string): Promise<ProjectSessionPreview>;
    navigationEnabled(): boolean;
    open(sessionId: string, messageId?: string): Promise<boolean | void>;
    create(input: {
      inputRefs?: readonly string[];
      workspacePath: string;
      name: string;
      initialPrompt: string;
      model?: ChatConfiguration;
      worktreeName?: string;
    }): Promise<{ workspacePath: string; sessionId: string; managedWorktree?: WorktreeRecord }>;
    createDraft(input: {
      workspacePath: string;
      name: string;
      initialPrompt: string;
      model?: ChatConfiguration;
    }): Promise<{ workspacePath: string; sessionId: string }>;
    contextSnapshot?(sessionId: string): CrossSessionContextSnapshot;
    sendMessage(
      sessionId: string,
      text: string,
      delivery: "prompt" | "follow-up" | "steer",
      crossSession?: CrossSessionMessageMetadata,
      inputRefs?: readonly string[],
    ): Promise<string>;
    compact(sessionId: string, instructions?: string): Promise<void>;
    query(sessionId: string, query: SessionInspectionQuery): Promise<JsonValue>;
    callCakeOperation(sessionId: string, command: string, input: JsonObject): Promise<JsonValue>;
    queueCommand(sessionId: string, command: string): Promise<QueuedSessionCommandReceipt>;
    reorderQueuedMessage(
      sessionId: string,
      itemId: string,
      position: number,
    ): Promise<QueuedConversationMessages>;
    scheduleMessage(input: {
      targetSessionId: string;
      text: string;
      sendAt: string;
    }): Promise<ScheduledMessage>;
    listScheduledMessages(sessionId?: string): Promise<readonly ScheduledMessage[]>;
    cancelScheduledMessage(id: string): Promise<void>;
    listPendingMessages(sessionId: string): Promise<QueuedConversationMessages>;
    dequeuePendingMessages(sessionId: string): Promise<QueuedConversationMessages>;
    removeQueuedMessage(sessionId: string, partId: string): Promise<QueuedConversationMessages>;
    steerQueuedMessage(sessionId: string, partId: string): Promise<QueuedConversationMessages>;
    sendQueuedMessageNow(sessionId: string, partId: string): Promise<QueuedConversationMessages>;
    abort(sessionId: string): Promise<void>;
    rename(sessionId: string, title: string): Promise<void>;
    setProjectSessionsResolved(sessionIds: readonly string[], resolved: boolean): Promise<number>;
  };
  presentation: {
    splitView(
      source: AgentControlSource,
      direction: "right" | "down",
    ): { kind: "project-session" | "cake-chat"; paneId: string; sessionId: string } | undefined;
    showNotification(input: {
      title: string;
      body: string;
      level: "info" | "success" | "warning" | "error";
      source?: AgentControlSource;
    }): Promise<void>;
    showAgentAction(input: {
      source: AgentControlSource;
      message: string;
      targetSessionId?: string;
      targetKind?: "project-session" | "cake-chat";
      coalesceKey: string;
    }): void;
  };
}

export interface AppControlSession {
  workspacePath: string;
  workspaceName: string;
  sessionId: string;
  /** Ready-made full-UUID `cake://session/<id>` link; never projected to a short reference. */
  deepLink: string;
  title: string;
  modified: string;
  messageCount: number;
  resolved: boolean;
  draft: boolean;
  sessionFile?: string;
  firstUserMessage?: string;
  managedWorktree?: WorktreeRecord;
  familyId?: string;
  familyParentSessionId?: string;
  familyChildSessionIds?: readonly string[];
  familyChildOrder?: number;
  familyDepth?: number;
  activity?: SessionActivity;
  labels?: readonly AppControlSessionLabel[];
  /** Present for sessions Cake Chat launched: their latest status and quiet report summary. */
  launch?: {
    status: LaunchedSessionStatus;
    launchedAt?: string;
    summary?: string;
    reportedAt?: string;
  };
}

export interface AppControlSessionLabel extends SessionLabel {
  scope: "global" | "project";
  projectPath?: string;
}

export interface AppControlState {
  selection: AppControlSelection;
  sessionLayout?: ReturnType<NonNullable<AppControlHost["state"]["sessionLayout"]>>;
  projectCount: number;
  sessionCount: number;
  projects: Array<{ path: string; name: string; sessionCount: number }>;
  attentionSessions: AppControlSession[];
  recentSessions: AppControlSession[];
}

export interface CoordinationThreadView {
  threadId: string;
  state: "open" | "closed";
  participants: Array<{
    sessionId: string;
    title: string;
    projectName: string;
    workingDirectory: string;
  }>;
  messageCount: number;
  maxMessages?: number;
  messages: CoordinationMessage[];
}

type AppControlSuccess =
  | { ok: true; command: "app.state"; state: AppControlState }
  | { ok: true; command: "app.user-selection"; text: string | null }
  | { ok: true; command: "settings.sections"; sections: typeof agentSettingsSections }
  | {
      ok: true;
      command: "settings.get" | "settings.update";
      scope: "window";
      section: CakeSettingsSectionId;
      settings: CakeSettingsSectionView["settings"];
    }
  | {
      ok: true;
      command:
        | "project.settings.get"
        | "project.settings.update"
        | "projects.settings.get"
        | "projects.settings.update";
      scope: "project";
      projectPath: string;
      settings: ProjectSettings;
    }
  | {
      ok: true;
      command: "app.split";
      direction: "right" | "down";
      kind: "project-session" | "cake-chat";
      paneId: string;
      sessionId: string;
    }
  | {
      ok: true;
      command: "sessions.list";
      sessions: AppControlSession[];
      attentionSessions: AppControlSession[];
    }
  | {
      ok: true;
      command: "sessions.list-family";
      familyId: string;
      rootSessionId: string;
      currentSessionId: string;
      sessions: AppControlSession[];
    }
  | {
      ok: true;
      command: "sessions.info";
      session: AppControlSession;
      selected: boolean;
      status: SessionActivity | "idle";
    }
  | {
      ok: true;
      command: "sessions.open";
      opened: { workspacePath?: string; sessionId: string; messageId?: string };
    }
  | {
      ok: true;
      command: "sessions.create";
      workspacePath: string;
      sessionId: string;
      title: string;
      status: "started";
      managedWorktree?: WorktreeRecord;
    }
  | {
      ok: true;
      command: "sessions.create-draft";
      workspacePath: string;
      sessionId: string;
      title: string;
      status: "saved-draft";
    }
  | {
      ok: true;
      command: "sessions.send" | "sessions.reply";
      target: SessionTarget;
      targetTitle: string;
      messageId: string;
      threadId?: string;
      messageNumber?: number;
      maxMessages?: number;
      delivery: "prompt" | "queue" | "steer";
      expectsResponse: boolean;
      /** Cake Chat senders only: how the requested result comes back. */
      report?: CakeChatReportPolicy;
      replyToMessageId?: string;
      recipientContext?: CrossSessionContextSnapshot;
      queue?: CrossSessionQueueSnapshot;
      status: CrossSessionDeliveryStatus;
    }
  | { ok: true; command: "sessions.thread"; thread: CoordinationThreadView }
  | { ok: true; command: "sessions.close-thread"; thread: CoordinationThreadView; status: "closed" }
  | { ok: true; command: "sessions.compact"; target: SessionTarget; status: "compacted" }
  | {
      ok: true;
      command:
        | "sessions.cake"
        | "sessions.history"
        | "sessions.compactions"
        | "sessions.tree"
        | "sessions.context"
        | "sessions.usage"
        | "sessions.commands";
      target: SessionTarget;
      result: JsonValue;
    }
  | {
      ok: true;
      command: "sessions.queue-command";
      target: SessionTarget;
      itemId: string;
      status: "queued";
    }
  | { ok: true; command: "sessions.reorder"; messages: QueuedConversationMessages }
  | {
      ok: true;
      command: "sessions.schedule";
      target: SessionTarget;
      scheduledMessage: ScheduledMessage;
      status: "scheduled";
    }
  | { ok: true; command: "sessions.scheduled"; messages: readonly ScheduledMessage[] }
  | { ok: true; command: "sessions.cancel-scheduled"; id: string; status: "cancelled" }
  | { ok: true; command: "sessions.pending"; result: JsonValue }
  | {
      ok: true;
      command:
        | "sessions.dequeue"
        | "sessions.cancel-queued"
        | "sessions.steer-queued"
        | "sessions.send-now"
        | "sessions.clear-queue";
      messages: QueuedConversationMessages;
    }
  | { ok: true; command: "sessions.abort"; target: SessionTarget; status: "stopping" }
  | { ok: true; command: "sessions.rename"; target: SessionTarget; title: string }
  | {
      ok: true;
      command: "sessions.set-labels";
      target: SessionTarget;
      labels: AppControlSessionLabel[];
    }
  | { ok: true; command: "session-labels.list"; labels: AppControlSessionLabel[] }
  | {
      ok: true;
      command: "session-labels.add" | "session-labels.update";
      label: AppControlSessionLabel;
    }
  | {
      ok: true;
      command: "session-labels.remove" | "session-labels.reorder";
      label: AppControlSessionLabel;
    }
  | {
      ok: true;
      command: "worktrees.merge";
      sessionId: string;
      workingDirectory: string;
      operationId: string;
    }
  | {
      ok: true;
      command: "worktrees.discard";
      sessionId: string;
      workingDirectory: string;
      keepBranch: boolean;
    }
  | {
      ok: true;
      command: "sessions.resolve";
      targets: ReadonlyArray<{ kind: "project" | "cake-chat"; sessionId: string }>;
      resolved: boolean;
      sessionCount: number;
    }
  | { ok: true; command: "vscode.enter"; entered: true }
  | {
      ok: true;
      command: "vscode.open";
      opened: EditorLocation;
      selection: EditorSelectionOpenResult;
    }
  | { ok: true; command: "vscode.selections.list"; state: EditorSelectionState }
  | {
      ok: true;
      command: "vscode.selections.remove" | "vscode.selections.clear";
      update: EditorSelectionUpdate;
    }
  | {
      ok: true;
      command:
        | "vscode.layout.set"
        | "vscode.diff.open"
        | "vscode.editor.status"
        | "vscode.diagnostics.list"
        | "vscode.panel.show";
      result: JsonValue;
    }
  | { ok: true; command: "notifications.send"; status: "queued" }
  | {
      ok: true;
      command: "agent.action";
      action: "compact" | "rename" | "resolve" | "restore" | "set-model";
      detail?: string;
    };

export type AppControlCommand = AppControlSuccess["command"];
export type AppControlResult =
  | AppControlSuccess
  | { ok: false; command: AppControlCommand; error: string };

interface SessionTarget {
  workspacePath: string;
  sessionId: string;
}
