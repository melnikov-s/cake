import {
  type SessionInspectionQuery,
  type QueuedSessionCommandReceipt,
} from "../../contracts/conversations/session-query-data";
import type {
  AgentSettingsInvocation,
  agentSettingsSections,
} from "../../contracts/application/agent-settings-schema";
import type { AgentSessionStatus } from "../../contracts/project-sessions/agent-session-list";
import type { TurnStop } from "../../contracts/conversations/turn-stop";
import { type JsonValue } from "../../contracts/serialization/json-contract";
import {
  type ChatConfiguration,
  type ProjectRecord,
} from "../../contracts/conversations/session-contract";
import { type CakeChatSummary } from "../../contracts/cake-chats/cake-chat-data";
import type { SessionSummary } from "../models/SessionSummary";
import type { WorktreeRecord } from "../../contracts/worktrees/managed-worktree-data";
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
  CrossSessionDeliveryStatus,
} from "../../contracts/conversations/cross-session-coordination";
import type {
  CrossSessionContextSnapshot,
  CrossSessionQueueSnapshot,
} from "../../contracts/conversations/cross-session-message";
import type { QueuedConversationMessages } from "../../contracts/conversations/conversation-data";
import { type SessionActivity } from "../lib/session-activity";
import type { LaunchedSessionStatus } from "../lib/cake-chat-launches";
import type { ResultDelivery } from "../../contracts/conversations/result-delivery";
import {
  type CakeSettingsSectionId,
  type CakeSettingsSectionView,
  type CakeSettingsUpdate,
} from "../../contracts/application/cake-settings-data";
import {
  type ProjectSettings,
  type SessionLabel,
} from "../../contracts/application/application-data";

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
  vscode: AppControlVscodeSelectionsHost & {
    enter(source: AgentControlSource): Promise<void>;
    performEditorAction(source: AgentControlSource, action: VscodeEditorAction): Promise<JsonValue>;
  };
  projects: {
    /** Runs the sidebar's removal workflow; false when it failed and reported its own error. */
    remove(path: string, deleteSessions: boolean): Promise<boolean>;
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

    query(sessionId: string, query: SessionInspectionQuery): Promise<JsonValue>;
    queueCommand(sessionId: string, command: string): Promise<QueuedSessionCommandReceipt>;
    reorderQueuedMessage(
      sessionId: string,
      itemId: string,
      position: number,
    ): Promise<QueuedConversationMessages>;
    listPendingMessages(sessionId: string): Promise<QueuedConversationMessages>;
    dequeuePendingMessages(sessionId: string): Promise<QueuedConversationMessages>;
    removeQueuedMessage(sessionId: string, partId: string): Promise<QueuedConversationMessages>;
    steerQueuedMessage(sessionId: string, partId: string): Promise<QueuedConversationMessages>;
    sendQueuedMessageNow(sessionId: string, partId: string): Promise<QueuedConversationMessages>;
    /** `stop` records who deliberately stopped the session; it is never a failure. */
    abort(sessionId: string, stop: TurnStop): Promise<void>;
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

interface AppControlSession {
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

interface AppControlSessionLabel extends SessionLabel {
  scope: "global" | "project";
  projectPath?: string;
}

export interface AppControlState {
  selection: AppControlSelection;
  sessionLayout?: ReturnType<NonNullable<AppControlHost["state"]["sessionLayout"]>>;
  projectCount: number;
  sessionCount: number;
}

interface CoordinationThreadView {
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
      command: "settings.window.get" | "settings.window.update";
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
      total: number;
      offset: number;
      nextOffset: number | null;
      sessions: Array<{
        sessionId: string;
        title: string;
        kind: string;
        projectName?: string;
        status: AgentSessionStatus;
      }>;
    }
  | {
      ok: true;
      command: "sessions.list-family";
      familyId: string;
      rootSessionId: string;
      currentSessionId: string;
      total: number;
      offset: number;
      nextOffset: number | null;
      sessions: Array<{
        sessionId: string;
        title: string;
        status: AgentSessionStatus;
        familyParentSessionId?: string;
      }>;
    }
  | {
      ok: true;
      command: "sessions.info";
      session: AppControlSession;
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
      delivery: "fyi" | "prompt" | "queue" | "steer";
      expectsResponse: boolean;
      /** Cake Chat senders only: how the requested result comes back. */
      resultDelivery?: ResultDelivery;
      replyToMessageId?: string;
      recipientContext?: CrossSessionContextSnapshot;
      queue?: CrossSessionQueueSnapshot;
      status: CrossSessionDeliveryStatus;
    }
  | { ok: true; command: "sessions.thread"; thread: CoordinationThreadView }
  | { ok: true; command: "sessions.close-thread"; thread: CoordinationThreadView; status: "closed" }
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
  | {
      ok: true;
      command: "sessions.reorder";
      queue: { steeringCount: number; followUpCount: number };
    }
  | { ok: true; command: "sessions.pending" | "sessions.pending-info"; result: JsonValue }
  | {
      ok: true;
      command: "sessions.cancel-queued" | "sessions.steer-queued" | "sessions.send-now";
      queue: { steeringCount: number; followUpCount: number };
    }
  | {
      ok: true;
      command: "sessions.clear-queue";
      cleared: { steeringCount: number; followUpCount: number };
    }
  | { ok: true; command: "sessions.abort"; target: SessionTarget; status: "stopping" }
  | { ok: true; command: "sessions.rename"; target: SessionTarget; title: string }
  | {
      ok: true;
      command: "sessions.set-labels";
      target: SessionTarget;
      labels: AppControlSessionLabel[];
    }
  | {
      ok: true;
      command: "session-labels.list";
      labels: AppControlSessionLabel[];
      total: number;
      offset: number;
      nextOffset: number | null;
    }
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
  | {
      ok: true;
      command: "projects.remove";
      path: string;
      name: string;
      deleteSessions: boolean;
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
