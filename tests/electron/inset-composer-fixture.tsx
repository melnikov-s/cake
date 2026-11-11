import { createRoot } from "react-dom/client";
import { applySnapshot } from "r-state-tree";
import { StoreProvider } from "r-state-tree/react";
import { emptyProjectTodos, type ProjectTodo } from "../../src/contracts/projects/project-todos";
import { Chat } from "../../src/renderer/components/chat";
import { CakeChatComposerHeader } from "../../src/renderer/components/cake-chat-composer-header";
import { applyConversationSnapshot } from "../../src/renderer/reducers/ConversationReducer";
import { applySubagentUpdate } from "../../src/renderer/reducers/SubagentReducer";
import { createRendererStoreFixture } from "../app/renderer/renderer-store-fixture";
import { projectRecord, sessionSummary } from "../app/renderer/fixtures/catalog-fixtures";
import {
  SubagentHandleId,
  type SubagentActivity,
} from "../../src/contracts/subagents/subagent-data";

export interface InsetFixtureControls {
  update(activity: number, attention: number): void;
  calls: string[];
}

// Production Chat/header/Stores. Only external services and snapshot delivery are fixtures.
const ownerId = `project-chat:${"a".repeat(64)}`;
let items: ProjectTodo[] = [];
const calls: string[] = [];
const project = () => ({
  ...projectRecord({ path: "/project", name: "Cake" }),
  todos: { ...emptyProjectTodos(), items },
});
const fixture = createRendererStoreFixture({
  projects: [project()],
  client: {
    projectTodos: {
      activateAttention: async ({ id }) => {
        calls.push(`open:${id}`);
        items = items.filter((item) => item.id !== id);
        publish();
        return {
          todos: project().todos,
          resultPartIds: [],
          responseTurnId: "fixture",
          resultSource: "incoming",
        };
      },
      mutateUser: async ({ mutation }) => {
        if (mutation._tag === "SetAttention") {
          calls.push(`clear:${mutation.id}`);
          items = items.filter((item) => item.id !== mutation.id);
          publish();
        }
        return project().todos;
      },
    },
  },
});
applySnapshot(fixture.models.cakeChatCatalog, {
  loaded: true,
  sessions: [{ sessionId: ownerId, title: "Project Chat", projectPath: "/project" }],
});
const session = fixture.root.cakeChatCollectionStore.registry.load(ownerId);
applyConversationSnapshot(session.model, {
  sessionId: ownerId,
  sessionFile: "/fixture/history",
  workspacePath: "/project",
  parts: [
    {
      id: "request",
      kind: "text",
      role: "user",
      text: "Keep the conversation primary while work runs.",
      status: "complete",
    },
    {
      id: "response",
      kind: "text",
      role: "assistant",
      text: "The running sessions and queued findings stay just above your draft. Collapse either list without dismissing its work.",
      status: "complete",
    },
  ],
  models: [],
  thinkingLevel: "off",
  availableThinkingLevels: ["off"],
  streaming: false,
  diagnostics: [],
  commands: [],
  compatibility: { resources: [], diagnostics: [] },
  extensionUi: { statuses: [] },
  tree: [],
});
function publish() {
  applySnapshot(fixture.models.projects, { projects: [project()] });
}
let revision = 0;
function update(activity: number, attention: number) {
  items = Array.from({ length: attention }, (_, index) => ({
    id: `00000000-0000-4000-8000-${String(index + 11).padStart(12, "0")}`,
    title: index === 0 ? "Review keyboard navigation" : `Review finding ${index + 1}`,
    description: "Findings ready",
    status: "",
    revision: 0,
    state: "open",
    associations: [],
    needsAttention: true,
    attentionReason: "Choose the next step after reviewing the findings.",
    attentionSequence: index + 1,
  }));
  publish();
  applySnapshot(fixture.models.sessionCatalog, {
    sessions: Array.from({ length: Math.max(activity - 1, 0) }, (_, index) =>
      sessionSummary({
        sessionId: `10000000-0000-4000-8000-${String(index + 11).padStart(12, "0")}`,
        title:
          index === 0 ? "Verify shared composer surfaces" : `Inspect running work ${index + 1}`,
        projectPath: "/project",
        running: true,
        cakeChatLaunch: { requesterSessionId: ownerId, launchedAt: "2026-01-01T00:00:00Z" },
      }),
    ),
    resolvedHasMoreByProject: {},
  });
  applySubagentUpdate(fixture.models.subagentCatalog(ownerId), ownerId, {
    _tag: "Snapshot",
    revision: ++revision,
    parentSessionId: ownerId,
    activities: activity
      ? [
          {
            resolved: false,
            parentSessionId: ownerId,
            anchorPartId: "tool-spawn",
            handleId: SubagentHandleId.make("10000000-0000-4000-8000-000000000001"),
            revision,
            task: "Check compact layout",
            status: "running",
            streaming: true,
            resolvedModel: {
              requested: "current",
              source: "current",
              provider: "test",
              modelId: "model",
              thinkingLevel: "off",
              fallbacks: [],
            },
            fastMode: false,
            parts: [],
          } satisfies SubagentActivity,
        ]
      : [],
    backgroundActive: activity > 0,
  });
}
Object.assign(window, { insetFixture: { update, calls } });
update(3, 2);
createRoot(document.getElementById("root")!).render(
  <StoreProvider store={fixture.root}>
    <StoreProvider store={fixture.root.fullscreenSurfaceStore}>
      <Chat
        store={session.conversationSessionStore.chatStore}
        composerHeader={<CakeChatComposerHeader session={session} />}
        composerFocusEnabled={false}
      />
    </StoreProvider>
  </StoreProvider>,
);
