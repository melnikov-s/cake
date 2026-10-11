import { act, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { applySnapshot } from "r-state-tree";
import { StoreProvider } from "r-state-tree/react";
import type { WorktreeRecord } from "../../../src/contracts/worktrees/managed-worktree-data";
import type { WorktreeLandingOperation } from "../../../src/contracts/worktrees/worktree-landing-data";
import type { ConversationSnapshot } from "../../../src/ipc/conversation-data";
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
  options: RendererStoreFixtureOptions & { loadedIds?: readonly string[] },
) {
  const fixture = createRendererStoreFixture(options);
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
  const view = render(
    <StoreProvider store={fixture.root}>
      <App />
    </StoreProvider>,
  );
  return {
    user: userEvent.setup(),
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
