import { createRoot } from "react-dom/client";
import { TurnId } from "../../src/contracts/conversations/conversation-data";
import type { TestClientOverrides } from "../app/renderer/test-client";
import { formatSessionDigestReminder } from "../../src/contracts/cake-chats/session-digest-reminder";
import { flushSync } from "react-dom";
import { StoreProvider } from "r-state-tree/react";
import { ChatTranscript } from "../../src/renderer/components/chat-transcript";
import { Chat } from "../../src/renderer/components/chat";
import { createRendererStoreFixture } from "../app/renderer/renderer-store-fixture";
import { projectRecord, sessionSummary } from "../app/renderer/fixtures/catalog-fixtures";
import { applyConversationUpdate } from "../../src/renderer/reducers/ConversationReducer";
import type {
  ConversationSnapshot,
  UiPart,
} from "../../src/contracts/conversations/session-contract";

import type { CompiledInlineWidget } from "../../src/contracts/widgets/inline-widget-contract";
import { decodeArtifactLineageId } from "../../src/contracts/artifacts/artifact-lineage";
import type { ArtifactRevision } from "../../src/contracts/artifacts/artifact-lineage";

const parameters = new URLSearchParams(location.search);
const widget = JSON.parse(parameters.get("widget") ?? "null") as CompiledInlineWidget | null;
const widgetRevision: ArtifactRevision = {
  lineageId: decodeArtifactLineageId("scroll-widget"),
  metadata: {
    revision: 1,
    digest: "a".repeat(64),
    kind: "widget",
    publishedAt: new Date(0).toISOString(),
    publishedBySessionId: "ownership",
    workingDirectory: "/project",
  },
  snapshot: {
    protocol: "cake.artifact/v1",
    id: "scroll-widget",
    sessionId: "ownership",
    revision: 1,
    kind: "widget",
    title: "Scroll widget",
    payload: {
      language: "react",
      source: "",
      brief: "Scroll fixture",
      generationSessionId: "fixture",
      browser: { digest: "a".repeat(64) },
    },
    fallback: { markdown: "Scroll widget fallback" },
    interaction: { mode: "present" },
  },
};
const withUpdates = parameters.get("updates") === "true";
let releaseReport: (() => void) | undefined;
const reportReady = new Promise<void>((resolve) => {
  releaseReport = resolve;
});
const client: TestClientOverrides | undefined = withUpdates
  ? {
      sessionChats: {
        inspect: async (input) => {
          if (input.kind !== "messages-read") throw new Error("Expected original report read");
          await reportReady;
          const ref = `cake://session/${input.sessionId}?message=${input.entryId}`;
          const text = "## Report start\n\n" + "Detailed finding. ".repeat(900);
          return {
            message: {
              ref,
              link: ref,
              sessionId: input.sessionId,
              entryId: input.entryId,
              parentId: null,
              timestamp: new Date(0).toISOString(),
              role: "assistant",
              active: true,
              inputRefs: [],
              hasImages: false,
            },
            text,
            totalChars: text.length,
            offset: 0,
            nextOffset: null,
            truncated: false,
          };
        },
      },
    }
  : widget
    ? {
        inlineWidgets: { open: async () => widget },
        artifacts: {
          stateRead: async () => ({
            lineageId: widgetRevision.lineageId,
            version: 1,
            value: { title: "Saved widget content" },
          }),
          referenceMetadata: async () => ({
            lineage: {
              id: widgetRevision.lineageId,
              title: "Scroll widget",
              createdAt: widgetRevision.metadata.publishedAt,
              latestRevision: 1,
              latest: widgetRevision.metadata,
              stableRef: "cake://artifact/scroll-widget",
            },
            revision: widgetRevision.metadata,
            links: [],
            stableRef: "cake://artifact/scroll-widget",
            exactRef: "cake://artifact/scroll-widget@r1",
          }),
        },
      }
    : undefined;
const fixture = createRendererStoreFixture({
  client: {
    ...client,
    sessionChats: {
      ...client?.sessionChats,
      prompt: async ({ text }) => {
        parts = [
          ...parts,
          { kind: "text", id: `sent-${revision}`, role: "user", status: "complete", text },
        ];
        publish();
        render();
        return TurnId.make("10000000-0000-4000-8000-000000000001");
      },
    },
  },
  projects: [projectRecord({ path: "/project", name: "Project" })],
  sessions: [sessionSummary({ sessionId: "ownership", projectPath: "/project" })],
});
const session = fixture.root.sessionRegistry.load("ownership", "/project");
// The active session can send from its composer (the one scroll-to-bottom exception).
fixture.root.navigationStore.selectProjectSession("ownership");
fixture.root.projectWorkbenchStore.showLoadedSession("ownership");
const store = session.conversationSessionStore.chatStore;
let revision = 0;
if (widget) fixture.models.artifacts.upsertRevision(widgetRevision);
const count = Number(parameters.get("count") ?? 48);
const chatMode = parameters.get("chatMode");
let parts: UiPart[] = Array.from({ length: count }, (_, index) => ({
  kind: "text",
  id: `message-${index}`,
  role: index % 2 ? "assistant" : "user",
  status: "complete",
  text: `Message ${index}. ${"Reading context. ".repeat(20)}${parameters.get("images") === "true" && index % 2 ? `\n\n![History image ${index}](https://transcript.invalid/${index})` : ""}`,
}));
if (widget)
  parts.splice(count - 2, 0, {
    kind: "tool",
    id: "widget-publication",
    name: "cake",
    input: "widgets.present",
    state: "success",
    output: "Published",
    artifactId: "scroll-widget",
    artifactReference: "cake://artifact/scroll-widget@r1",
  });
if (withUpdates)
  parts.push({
    kind: "context",
    id: "session-updates",
    title: "Session updates",
    text: formatSessionDigestReminder({
      lines: [
        {
          reference: "theme",
          sessionId: "theme",
          title: "Sync open VS Code with Cake theme changes",
          status: "completed",
          summary: "Ready",
          resultMessageRef: "cake://session/theme?message=report",
        },
        {
          reference: "online",
          sessionId: "online",
          title: "Keep online control beside sidebar toggle",
          status: "completed",
          summary: "Ready",
          resultMessageRef: "cake://session/online?message=report",
        },
        {
          reference: "widgets",
          sessionId: "widgets",
          title: "Make widgets follow Cake theme live",
          status: "completed",
          summary: "Detailed update. ".repeat(900),
        },
      ],
      running: 0,
      interruptedReport: false,
    })!,
  });
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
let liveTimer: ReturnType<typeof setInterval> | undefined;
function render() {
  flushSync(() =>
    root.render(
      <StoreProvider store={fixture.root.fullscreenSurfaceStore}>
        {chatMode ? (
          <Chat
            store={store}
            transcriptBehavior={
              widget
                ? {
                    messageReferenceSessionId: session.sessionId,
                    inlineWidgets: fixture.root.inlineWidgetStore,
                    inlineArtifactPreviews: fixture.root.inlineArtifactPreviewStore,
                  }
                : undefined
            }
            compact={chatMode === "compact"}
            embedded={withUpdates && chatMode === "compact"}
          />
        ) : (
          <ChatTranscript
            store={store}
            behavior={
              widget
                ? {
                    messageReferenceSessionId: session.sessionId,
                    inlineWidgets: fixture.root.inlineWidgetStore,
                    inlineArtifactPreviews: fixture.root.inlineArtifactPreviewStore,
                  }
                : undefined
            }
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
  /** Release the external original-report read after opening its disclosure. */
  loadReport(): void;
  update(): void;
  /** Deliver live external projections after the transcript has already rendered. */
  partsUpdated(updates: UiPart[]): void;
  stream(): void;
  /** A complete assistant message arrives without any user action. */
  arrive(): void;
  activity(): void;
  insert(): void;
  navigate(): void;
  /** Starts app-like live updates: commits are scheduled by the observer, not flushed. */
  startLive(intervalMs: number, mode: string): void;
  stopLive(): void;
  /** Projects a longer version of an existing message (content growth in place). */
  grow(messageId: string): void;
  /** The id of the newest transcript part. */
  newestId(): string | undefined;
}
Reflect.set(window, "transcriptFixture", {
  loadReport() {
    releaseReport?.();
  },
  update() {
    publish();
    render();
  },
  partsUpdated(updates) {
    for (const part of updates) {
      // Keep the external snapshot in arrival order so update() also exercises rebuild ordering.
      const index = parts.findIndex((current) => current.id === part.id);
      if (index < 0) parts.push(part);
      else parts[index] = part;
      applyConversationUpdate(session.model, {
        _tag: "Event",
        revision: ++revision,
        event: { _tag: "PartUpdated", sessionId: "ownership", part },
      });
    }
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
  arrive() {
    parts = [
      ...parts,
      {
        kind: "text",
        id: `arrival-${revision}`,
        role: "assistant",
        status: "complete",
        text: `Arrival ${revision}. ${"Arriving content. ".repeat(25)}`,
      },
    ];
    publish();
    render();
  },
  newestId() {
    return parts.at(-1)?.id;
  },
  grow(messageId) {
    parts = parts.map((part) =>
      part.id === messageId && part.kind === "text"
        ? { ...part, text: `${part.text}\n\n${"Grown paragraph. ".repeat(40)}` }
        : part,
    );
    publish();
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
    store.transcriptInteraction.noteSentMessage();
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
  navigate() {
    store.transcriptInteraction.navigateToMessage("message-5");
    render();
  },
  startLive(intervalMs, mode) {
    let tick = 0;
    liveTimer = setInterval(() => {
      tick++;
      if (mode.includes("tool") && tick % 3 === 0) {
        const toolIndex = parts.findIndex((part) => part.id === "live-tool");
        const tool: UiPart = {
          kind: "tool",
          id: "live-tool",
          name: "bash",
          input: "build",
          state: "running",
          output: `Live ${tick}.\n${"Output line.\n".repeat(tick)}`,
        };
        parts =
          toolIndex >= 0
            ? parts.map((part, index) => (index === toolIndex ? tool : part))
            : [...parts, tool];
      } else if (mode.includes("arrive") && tick % 7 === 0) {
        parts = [
          ...parts,
          {
            kind: "text",
            id: `live-arrival-${tick}`,
            role: "assistant",
            status: "complete",
            text: `Live arrival ${tick}. ${"Arriving. ".repeat(30)}`,
          },
        ];
      } else {
        const last = parts.at(-1);
        parts =
          last?.kind === "text" && last.status === "streaming"
            ? [...parts.slice(0, -1), { ...last, text: last.text + "word ".repeat(6) }]
            : [
                ...parts,
                {
                  kind: "text",
                  id: `live-${tick}`,
                  role: "assistant",
                  status: "streaming",
                  text: "word ",
                },
              ];
      }
      // No render(): the observer schedules its own commit, as live projections do.
      publish(true);
    }, intervalMs);
  },
  stopLive() {
    clearInterval(liveTimer);
  },
} satisfies TranscriptOwnershipFixture);
