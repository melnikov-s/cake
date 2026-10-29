/** @vitest-environment jsdom */
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { UiPart } from "../../../src/contracts/conversations/session-contract";
import { ChatTranscript } from "../../../src/renderer/components/chat-transcript";
import { applyConversationUpdate } from "../../../src/renderer/reducers/ConversationReducer";
import type { MessageSelection } from "../../../src/renderer/stores/TranscriptInteractionStore";
import { createRendererStoreFixture } from "./renderer-store-fixture";
import { projectRecord, sessionSummary } from "./fixtures/catalog-fixtures";

// Keep main's compact selection-reveal policy with real Root composition.
// Only the DOM measurement boundary is controlled. The existing real Virtuoso
// runtime suite owns cancellation/compensation, and session-scroll-position's
// Electron workflows own message-anchor restoration and actual native scrolling.
let fixture: ReturnType<typeof createRendererStoreFixture>;
let revision = 0;
function Transcript({
  parts,
  sessionId,
  virtualized = true,
  messageSelection,
}: {
  parts: UiPart[];
  sessionId: string;
  virtualized?: boolean;
  messageSelection?: MessageSelection;
}) {
  const session = fixture.root.sessionRegistry.load(sessionId, "/project");
  const store = session.conversationSessionStore.chatStore;
  useEffect(() => {
    applyConversationUpdate(session.model, {
      _tag: "Snapshot",
      revision: ++revision,
      snapshot: {
        sessionId,
        sessionFile: `/project/${sessionId}.jsonl`,
        parts,
        streaming: false,
        models: [],
        thinkingLevel: "off",
        availableThinkingLevels: ["off"],
        diagnostics: [],
        commands: [],
        compatibility: { resources: [], diagnostics: [] },
        extensionUi: { statuses: [] },
        tree: [],
      },
    });
    store.transcriptInteraction.messageSelection = messageSelection;
  }, [session, store, parts, sessionId, messageSelection]);
  return <ChatTranscript store={store} virtualized={virtualized} key={sessionId} />;
}

describe("Transcript measured-scroll policy boundary", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    revision = 0;
    fixture = createRendererStoreFixture({
      projects: [projectRecord({ path: "/project", name: "Project" })],
      sessions: ["session-1", "session-2", "compact"].map((sessionId) =>
        sessionSummary({ sessionId, projectPath: "/project" }),
      ),
    });
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    fixture[Symbol.dispose]();
    container.remove();
  });

  it("immediately reveals a compact selection above the composer without animating", () => {
    const parts: UiPart[] = [
      { id: "assistant-1", kind: "text", role: "assistant", text: "Answer", status: "complete" },
    ];
    const render = (messageSelection?: MessageSelection) =>
      root.render(
        <Transcript
          parts={parts}
          sessionId="compact"

          virtualized={false}
          messageSelection={messageSelection}
        />,
      );
    act(() => render());
    const scroller = container.querySelector<HTMLElement>(".transcript")!;
    const item = container.querySelector<HTMLElement>('[data-slot="transcript-item"]')!;
    scroller.getBoundingClientRect = () => new DOMRect(0, 0, 0, 600);
    scroller.style.setProperty("--composer-dock-height", "100px");
    item.getBoundingClientRect = () => new DOMRect(0, 900, 0, 100);
    act(() => render({ messageId: "assistant-1", origin: "keyboard", revision: 1 }));
    expect(scroller.scrollTop).toBe(516);
  });
});
