/** @vitest-environment jsdom */
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { VirtuosoMockContext } from "react-virtuoso";
import { afterEach, expect, it } from "vitest";
import type { DiscussionThread } from "../../../src/contracts/discussion-sessions/discussion-session-data";
import type { PiSettings, UiPart } from "../../../src/contracts/conversations/session-contract";
import { Chat } from "../../../src/renderer/components/chat";
import { SettingsPage } from "../../../src/renderer/components/settings-page";
import { WorkLogControls } from "../../../src/renderer/components/work-log-controls";
import {
  applyConversationSnapshot,
  applyDiscussionSessionUpdate,
} from "../../../src/renderer/reducers/ConversationReducer";
import { applyDiscussionCatalogUpdate } from "../../../src/renderer/reducers/DiscussionReducer";
import { applySubagentUpdate } from "../../../src/renderer/reducers/SubagentReducer";
import { configurationSnapshot } from "./chat-configuration-workflow-fixture";
import { projectRecord, sessionSummary } from "./fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "./renderer-store-fixture";
import { parentSessionId, workerActivity } from "./subagent-activity-workflow-fixture";
import { readFile } from "./work-log-presentation-workflow-fixture";

const initialSettings: PiSettings = {
  autoCompact: true,
  autoResizeImages: true,
  blockImages: false,
  enableSkillCommands: true,
  steeringMode: "one-at-a-time",
  followUpMode: "one-at-a-time",
  transport: "auto",
  httpIdleTimeoutMs: 300000,
  hideThinkingBlock: false,
  mermaidRenderingMode: "final",
  showCacheMissNotices: false,
  collapseChangelog: false,
  quietStartup: false,
  enableInstallTelemetry: false,
  defaultProjectTrust: "ask",
  doubleEscapeAction: "tree",
  treeFilterMode: "default",
  anthropicExtraUsageWarning: true,
  retryEnabled: true,
  defaultTools: null,
  codemodeInlineBudget: 3000,
  shellPath: "",
  shellCommandPrefix: "",
  npmCommand: ["npm"],
  packages: [],
  extensions: [],
  skills: [],
  prompts: [],
  reloadPending: false,
};

afterEach(cleanup);

it("shares work-log choices and disclosure resets across parent, compact side chat and compact worker", async () => {
  using fixture = await renderPreferences();
  const parent = within(screen.getByRole("region", { name: "Parent" }));
  const side = within(screen.getByRole("region", { name: "Side chat" }));
  const worker = within(screen.getByRole("region", { name: "Worker" }));
  const groups = () =>
    screen.getAllByText("Work log", { exact: true }).map((node) => node.closest("details")!);
  const choose = async (pane: typeof parent, name: string) => {
    await fixture.user.click(pane.getByRole("button", { name: "Work log display options" }));
    await fixture.user.click(screen.getByRole("button", { name }));
    await fixture.user.keyboard("{Escape}");
  };
  expect(groups().map((group) => group.open)).toEqual([false, false, false]);
  await choose(worker, "Full work logs");
  expect(groups().map((group) => group.open)).toEqual([true, true, true]);
  for (const pane of [parent, side, worker]) {
    expect(pane.getByRole("button", { name: "read shared.ts" }).getAttribute("aria-expanded")).toBe(
      "true",
    );
    expect(pane.getByText("Contents of shared")).toBeDefined();
  }
  // A per-item choice survives ordinary projection changes and is independent in each chat.
  await fixture.user.click(side.getByRole("button", { name: "read shared.ts" }));
  expect(side.getByRole("button", { name: "read shared.ts" }).getAttribute("aria-expanded")).toBe(
    "false",
  );
  fixture.publish();
  expect(side.getByRole("button", { name: "read shared.ts" }).getAttribute("aria-expanded")).toBe(
    "false",
  );
  expect(worker.getByRole("button", { name: "read shared.ts" }).getAttribute("aria-expanded")).toBe(
    "true",
  );
  // Group overrides also reset when another chat changes the global expansion choice.
  await fixture.user.click(parent.getByText("Work log", { exact: true }));
  await choose(worker, "Collapsed work logs");
  expect(groups().map((group) => group.open)).toEqual([false, false, false]);
  await choose(parent, "Full work logs");
  expect(groups().map((group) => group.open)).toEqual([true, true, true]);
  expect(side.getByRole("button", { name: "read shared.ts" }).getAttribute("aria-expanded")).toBe(
    "true",
  );
  await choose(side, "Log view mode");
  await fixture.user.click(worker.getByRole("button", { name: "Work log display options" }));
  expect(screen.getByRole("button", { name: "Log view mode" }).getAttribute("aria-pressed")).toBe(
    "true",
  );
});

it("applies Hide thinking to nested workers while respecting each Pi conversation's explicit setting", async () => {
  using fixture = await renderPreferences();
  // Expansion uses the same real work-log control, not a synthetic Store mutation.
  await fixture.user.click(
    within(screen.getByRole("region", { name: "Worker" })).getByRole("button", {
      name: "Work log display options",
    }),
  );
  await fixture.user.click(screen.getByRole("button", { name: "Full work logs" }));
  await fixture.user.keyboard("{Escape}");
  expect(screen.getAllByText("Shared reasoning")).toHaveLength(3);
  await fixture.user.click(screen.getByRole("switch", { name: "Hide thinking" }));
  expect(screen.queryByText("Shared reasoning")).toBeNull();
  await fixture.user.click(screen.getByRole("switch", { name: "Hide thinking" }));
  expect(screen.getAllByText("Shared reasoning")).toHaveLength(3);
  // An effective per-conversation Pi setting takes precedence over the window default.
  fixture.publish(true);
  expect(
    within(screen.getByRole("region", { name: "Parent" })).queryByText("Shared reasoning"),
  ).toBeNull();
  expect(
    within(screen.getByRole("region", { name: "Worker" })).getByText("Shared reasoning"),
  ).toBeDefined();
});

async function renderPreferences() {
  let settings = initialSettings;
  const fixture = createRendererStoreFixture({
    projects: [projectRecord({ path: "/project" })],
    sessions: [sessionSummary({ sessionId: parentSessionId, projectPath: "/project" })],
    client: {
      piSettings: {
        get: async () => settings,
        update: async (update) => {
          if (update.key !== "hideThinkingBlock") throw new Error("Unexpected preference update");
          settings = { ...settings, hideThinkingBlock: update.value };
          publish();
          return settings;
        },
      },
    },
  });
  const session = fixture.root.sessionRegistry.load(parentSessionId, "/project");
  fixture.root.navigationStore.selectProjectSession(parentSessionId);
  fixture.root.projectWorkbenchStore.showLoadedSession(parentSessionId);
  const thread: DiscussionThread = {
    id: "preferences-side",
    sidecarSessionId: "preferences-sidecar",
    parentSessionId,
    workingDirectory: "/project",
    anchor: {
      path: `session:${parentSessionId}`,
      view: "session",
      start: { diffLine: 0 },
      end: { diffLine: 0 },
      selectedText: "",
      contextBefore: "",
      contextAfter: "",
      diff: "",
    },
    parts: [],
    status: "open",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
  const parts: UiPart[] = [
    readFile("shared"),
    { id: "thinking", kind: "reasoning", text: "Shared reasoning", status: "complete" },
  ];
  let revision = 0;
  function publish(parentHideThinking = settings.hideThinkingBlock) {
    applyConversationSnapshot(session.model, {
      ...configurationSnapshot(parentSessionId, []),
      parts,
      piSettings: { ...settings, hideThinkingBlock: parentHideThinking },
    });
    applyDiscussionSessionUpdate(
      fixture.models.discussionConversation("preferences-sidecar", "/project"),
      "preferences-sidecar",
      {
        _tag: "Snapshot",
        revision: ++revision,
        snapshot: {
          identity: {
            _tag: "DiscussionSession",
            sessionId: "preferences-sidecar",
            parentSessionId,
          },
          conversation: {
            ...configurationSnapshot("preferences-sidecar", []),
            parts,
            piSettings: settings,
          },
        },
      },
    );
  }
  publish();
  applyDiscussionCatalogUpdate(fixture.models.discussionCatalog(parentSessionId), parentSessionId, {
    _tag: "Snapshot",
    revision: 1,
    parentSessionId,
    threads: [thread],
  });
  applySubagentUpdate(fixture.models.subagentCatalog(parentSessionId), parentSessionId, {
    _tag: "Snapshot",
    revision: 1,
    parentSessionId,
    activities: [workerActivity({ parts, status: "complete", streaming: false })],
    backgroundActive: false,
  });
  const chats = [
    session.conversationSessionStore.chatStore,
    fixture.root.reviewsStore.chatStore(thread.id)!,
    session.subagentActivityStore.chatStores[0]!,
  ];
  for (const chat of chats) chat.transcriptInteraction.setTranscriptScrollPosition({ kind: "top" });
  await fixture.root.settingsStore.providers.loadSettings();
  fixture.root.settingsStore.activePage = "agent";
  const view = render(
    <>
      <SettingsPage settings={fixture.root.settingsStore} />
      <VirtuosoMockContext.Provider value={{ viewportHeight: 800, itemHeight: 100 }}>
        {chats.map((chat, index) => (
          <section key={chat.id} aria-label={["Parent", "Side chat", "Worker"][index]}>
            <WorkLogControls store={chat} />
            <Chat store={chat} compact={index > 0} embedded composerFocusEnabled={false} />
          </section>
        ))}
      </VirtuosoMockContext.Provider>
    </>,
  );
  return {
    user: userEvent.setup(),
    publish(parentHideThinking?: boolean) {
      act(() => publish(parentHideThinking));
    },
    [Symbol.dispose]() {
      view.unmount();
      fixture[Symbol.dispose]();
    },
  };
}
