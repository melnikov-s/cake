import { act, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { applySnapshot, toSnapshot } from "r-state-tree";
import type { CakeChatSummary } from "../../../src/contracts/cake-chats/cake-chat-data";
import { StoreProvider } from "r-state-tree/react";
import type { ProjectRecord } from "../../../src/contracts/application/application-data";
import type { CakeEditorSettings } from "../../../src/contracts/application/cake-settings-data";
import type { WorktreeRecord } from "../../../src/contracts/worktrees/managed-worktree-data";
import type { WorktreeLandingOperation } from "../../../src/contracts/worktrees/worktree-landing-data";
import type {
  ConversationEvent,
  ConversationSnapshot,
} from "../../../src/contracts/conversations/conversation-data";
import type { InterviewRecord } from "../../../src/contracts/interviews/interview";
import { App } from "../../../src/renderer/components/app";
import { applyConversationUpdate } from "../../../src/renderer/reducers/ConversationReducer";
import {
  createRendererStoreFixture,
  type RendererStoreFixtureOptions,
} from "./renderer-store-fixture";
import { sessionSummary, type SessionSummaryFixture } from "./fixtures/catalog-fixtures";

export function sidebarSummary(
  sessionId: string,
  day = 1,
  extra: Partial<SessionSummaryFixture> = {},
) {
  return sessionSummary({
    sessionId,
    projectPath: "/cake",
    modifiedAt: new Date(Date.UTC(2026, 0, day)).toISOString(),
    ...extra,
  });
}

export const sidebarFamily = [
  sidebarSummary("root", 1, {
    familyId: "root",
    familyChildSessionIds: ["planner", "sibling"],
    familyDepth: 0,
  }),
  sidebarSummary("planner", 2, {
    familyId: "root",
    familyParentSessionId: "root",
    familyChildSessionIds: ["worker"],
    familyChildOrder: 0,
    familyDepth: 1,
  }),
  sidebarSummary("worker", 30, {
    familyId: "root",
    familyParentSessionId: "planner",
    familyChildOrder: 0,
    familyDepth: 2,
  }),
  sidebarSummary("sibling", 1, {
    familyId: "root",
    familyParentSessionId: "root",
    familyChildOrder: 1,
    familyDepth: 1,
  }),
];

function snapshot(sessionId: string): ConversationSnapshot {
  return {
    sessionId,
    sessionFile: `/sessions/${sessionId}.jsonl`,
    parts: [],
    models: [],
    thinkingLevel: "off",
    availableThinkingLevels: ["off"],
    streaming: false,
    diagnostics: [],
    commands: [],
    compatibility: { resources: [], diagnostics: [] },
    extensionUi: { statuses: [] },
    tree: [],
  };
}

export function renderSidebarNavigation(
  options: RendererStoreFixtureOptions & {
    loadedIds?: readonly string[];
    worktrees?: readonly WorktreeRecord[];
    ide?: {
      sidebarAutoHide: "always" | "below-width";
      width?: CakeEditorSettings["sidebarAutoHideWidth"];
    };
  },
) {
  const fixture = createRendererStoreFixture({
    ...options,
    client: {
      ...options.client,
      vscode: {
        open: async () => undefined,
        updateBounds: async () => undefined,
        updateAnnotations: async () => undefined,
        updateSelectionHighlights: async () => undefined,
        setTheme: async () => undefined,
        ...options.client?.vscode,
      },
    },
  });
  void fixture.root.sessionRegistry.pendingSessions.refreshSavedDrafts();
  applySnapshot(fixture.models.worktrees, { worktrees: [...(options.worktrees ?? [])] });
  let revision = 1;
  for (const sessionId of options.loadedIds ?? []) {
    const summary = options.sessions!.find((session) => session.sessionId === sessionId)!;
    fixture.root.sessionRegistry.load(sessionId, summary.workingDirectory);
    applyConversationUpdate(
      fixture.models.projectConversation(sessionId, summary.workingDirectory),
      {
        _tag: "Snapshot",
        revision: 1,
        snapshot: snapshot(sessionId),
      },
    );
  }
  if (options.ide) {
    const id = options.loadedIds![0]!;
    fixture.root.settingsStore.embeddedEditor.sidebarAutoHide = options.ide.sidebarAutoHide;
    fixture.root.settingsStore.embeddedEditor.sidebarAutoHideWidth = options.ide.width ?? 1440;
    fixture.root.appShellStore.selectProjectSession(id);
    fixture.root.projectWorkbenchStore.showLoadedSession(id);
    fixture.root.sessionLayoutStore.ensureSession(id);
    fixture.root.projectWorkbenchStore.presentationStore.embeddedEditorStore.applyState({
      status: "ready",
    });
  }
  const view = render(
    <StoreProvider store={fixture.root}>
      <App />
    </StoreProvider>,
  );
  return {
    user: userEvent.setup(),
    snapshot: () => toSnapshot(fixture.root),
    async publishProjectChats(sessions: readonly CakeChatSummary[]) {
      await act(async () =>
        applySnapshot(fixture.models.cakeChatCatalog, {
          loaded: true,
          sessions: [...sessions],
          resolvedHasMore: false,
        }),
      );
    },
    async publishProjectChatStreaming(sessionId: string, streaming: boolean) {
      await act(async () =>
        applyConversationUpdate(fixture.models.cakeChatConversation(sessionId), {
          _tag: "Event",
          revision: ++revision,
          event: { _tag: "StreamingChanged", sessionId, streaming },
        }),
      );
    },
    hostToggleSidebar() {
      // VS Code owns this toolbar control. Deliver its documented host event;
      // this is not proof of Electron/native-toolbar event delivery.
      act(() =>
        fixture.root.projectWorkbenchStore.receive({
          type: "embedded-editor-toggle-sidebar",
          workspacePath: "/cake",
        }),
      );
    },
    async publishStreaming(sessionIds: readonly string[], streaming: boolean) {
      await act(async () => {
        for (const sessionId of sessionIds) {
          const summary = options.sessions!.find((session) => session.sessionId === sessionId)!;
          applyConversationUpdate(
            fixture.models.projectConversation(sessionId, summary.workingDirectory),
            {
              _tag: "Event",
              revision: ++revision,
              event: { _tag: "StreamingChanged", sessionId, streaming },
            },
          );
        }
      });
    },
    async publishInterview(record: InterviewRecord) {
      await act(async () =>
        fixture.root.sessionRegistry.findSession(record.sessionId)!.receive({
          type: "interview-requested",
          operationId: "interview-operation",
          interviewRequestId: "request",
          record,
        }),
      );
    },
    async publishEvent(event: Exclude<ConversationEvent, { _tag: "SnapshotUpdated" }>) {
      const summary = options.sessions!.find((session) => session.sessionId === event.sessionId)!;
      await act(async () =>
        applyConversationUpdate(
          fixture.models.projectConversation(event.sessionId, summary.workingDirectory),
          { _tag: "Event", revision: ++revision, event },
        ),
      );
    },
    async publishProjects(projects: readonly ProjectRecord[]) {
      await act(async () => applySnapshot(fixture.models.projects, { projects: [...projects] }));
    },
    async publishConversation(sessionId: string, changes: Partial<ConversationSnapshot>) {
      const summary = options.sessions!.find((session) => session.sessionId === sessionId)!;
      await act(async () =>
        applyConversationUpdate(
          fixture.models.projectConversation(sessionId, summary.workingDirectory),
          {
            _tag: "Snapshot",
            revision: ++revision,
            snapshot: { ...snapshot(sessionId), ...changes },
          },
        ),
      );
    },
    async publishSessions(sessions: readonly SessionSummaryFixture[]) {
      await act(async () =>
        applySnapshot(fixture.models.sessionCatalog, {
          sessions: [...sessions],
          resolvedHasMoreByProject: {},
        }),
      );
    },
    async publishWorktrees(worktrees: readonly WorktreeRecord[]) {
      await act(async () => applySnapshot(fixture.models.worktrees, { worktrees: [...worktrees] }));
    },
    async publishWorktreeOperations(operations: readonly WorktreeLandingOperation[]) {
      await act(async () =>
        applySnapshot(fixture.models.worktreeOperations, { operations: [...operations] }),
      );
    },
    [Symbol.dispose]() {
      view.unmount();
      fixture[Symbol.dispose]();
    },
  };
}
