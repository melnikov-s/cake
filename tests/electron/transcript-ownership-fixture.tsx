import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { StoreProvider } from "r-state-tree/react";
import {
  ChatTranscript,
  type ChatTranscriptHandle,
} from "../../src/renderer/components/chat-transcript";
import { Chat } from "../../src/renderer/components/chat";
import { createRendererStoreFixture } from "../app/renderer/renderer-store-fixture";
import { projectRecord, sessionSummary } from "../app/renderer/fixtures/catalog-fixtures";
import { applyConversationUpdate } from "../../src/renderer/reducers/ConversationReducer";
import type {
  ConversationSnapshot,
  UiPart,
} from "../../src/contracts/conversations/session-contract";

const fixture = createRendererStoreFixture({
  projects: [projectRecord({ path: "/project", name: "Project" })],
  sessions: [sessionSummary({ sessionId: "ownership", projectPath: "/project" })],
});
const session = fixture.root.sessionRegistry.load("ownership", "/project");
const store = session.conversationSessionStore.chatStore;
let revision = 0;
const parameters = new URLSearchParams(location.search);
const count = Number(parameters.get("count") ?? 48);
const chatMode = parameters.get("chatMode");
let parts: UiPart[] = Array.from({ length: count }, (_, index) => ({
  kind: "text",
  id: `message-${index}`,
  role: index % 2 ? "assistant" : "user",
  status: "complete",
  text: `Message ${index}. ${"Reading context. ".repeat(20)}`,
}));
const snapshot: ConversationSnapshot = {
  sessionId: "ownership",
  workspacePath: "/project",
  sessionFile: "/project/ownership.jsonl",
  parts,
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
function publish(streaming = false) {
  applyConversationUpdate(session.model, {
    _tag: "Snapshot",
    revision: ++revision,
    snapshot: { ...snapshot, parts, streaming },
  });
}
publish();
const root = createRoot(document.getElementById("root")!);
let handle: ChatTranscriptHandle | null = null;
function render() {
  flushSync(() =>
    root.render(
      <StoreProvider store={fixture.root.fullscreenSurfaceStore}>
        {chatMode ? (
          <Chat store={store} compact={chatMode === "compact"} />
        ) : (
          <ChatTranscript
            store={store}
            ref={(value) => {
              handle = value;
            }}
            footer={<div>Activity revision {revision}</div>}
          />
        )}
      </StoreProvider>,
    ),
  );
}
render();

// These entry points control only external projection delivery / React commit
// ordering. DOM scrolling, measurements, Virtuoso and transcript policy are real.
export interface TranscriptOwnershipFixture {
  update(): void;
  stream(): void;
  activity(): void;
  insert(): void;
  jump(): void;
  navigate(): void;
}
Reflect.set(window, "transcriptFixture", {
  update() {
    publish();
    render();
  },
  stream() {
    const last = parts.at(-1);
    parts =
      last?.kind === "text" && last.status === "streaming"
        ? [...parts.slice(0, -1), { ...last, text: last.text + "Streaming chunk. ".repeat(30) }]
        : [
            ...parts,
            {
              kind: "text",
              id: `chunk-${revision}`,
              role: "assistant",
              status: "streaming",
              text: "Streaming chunk. ".repeat(30),
            },
          ];
    publish(true);
    render();
  },
  activity() {
    const toolIndex = parts.findIndex((part) => part.id === "tool");
    const tool: UiPart = {
      kind: "tool",
      id: "tool",
      name: "read",
      input: "README.md",
      state: "running",
      output: `Activity ${revision}. ${"Output. ".repeat(revision * 5)}`,
    };
    parts =
      toolIndex >= 0
        ? parts.map((part, index) => (index === toolIndex ? tool : part))
        : [...parts, tool];
    publish(true);
    render();
  },
  insert() {
    handle?.scrollToBottom({ forMessageInsertion: true });
    parts = [
      ...parts,
      {
        kind: "text",
        id: `user-${revision}`,
        role: "user",
        status: "complete",
        text: "User insertion. ".repeat(20),
      },
    ];
    publish();
    render();
  },
  jump() {
    handle?.scrollToBottom();
  },
  navigate() {
    store.transcriptInteraction.navigateToMessage("message-5");
    render();
  },
} satisfies TranscriptOwnershipFixture);
