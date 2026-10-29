/** @vitest-environment jsdom */
import React, { act, forwardRef, useEffect, useImperativeHandle } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UiPart } from "../../../src/contracts/conversations/session-contract";
import { ChatTranscript } from "../../../src/renderer/components/chat-transcript";
import { applyConversationUpdate } from "../../../src/renderer/reducers/ConversationReducer";
import type { MessageSelection } from "../../../src/renderer/stores/TranscriptInteractionStore";
import { createRendererStoreFixture } from "./renderer-store-fixture";
import { projectRecord, sessionSummary } from "./fixtures/catalog-fixtures";

const { scrollToIndex, cancelScrollToIndex, virtualizedLifecycle, virtualizedProps } = vi.hoisted(
  () => ({
    scrollToIndex: vi.fn(),
    cancelScrollToIndex: vi.fn(),
    virtualizedLifecycle: vi.fn(),
    virtualizedProps: { current: undefined as undefined | Record<string, unknown> },
  }),
);

// Control only the external virtualizer measurement/imperative boundary.
// Cake's Conversation and VirtualizedConversation composition remains real.
// Native geometry is verified by the Electron scroll/selection suites.
vi.mock("react-virtuoso", () => ({
  Virtuoso: forwardRef(function ControlledVirtuoso(
    props: {
      className?: string;
      data: Array<{ id: string }>;
      computeItemKey?: (index: number, item: { id: string }) => React.Key;
      itemContent: (index: number, item: { id: string }) => React.ReactNode;
      customScrollParent?: HTMLElement;
    },
    ref,
  ) {
    virtualizedProps.current = { ...props };
    useImperativeHandle(ref, () => ({
      getState: (callback: (state: unknown) => void) =>
        callback({
          ranges: [{ startIndex: 0, endIndex: props.data.length - 1, size: 100 }],
          scrollTop: props.customScrollParent?.scrollTop ?? 0,
        }),
      scrollToIndex,
      cancelScrollToIndex,
    }));
    useEffect(() => {
      virtualizedLifecycle("mounted");
      return () => {
        virtualizedLifecycle("unmounted");
      };
    }, []);
    return (
      <div className={props.className}>
        {props.data.map((item, index) => (
          <React.Fragment key={props.computeItemKey?.(index, item) ?? item.id}>
            {props.itemContent(index, item)}
          </React.Fragment>
        ))}
      </div>
    );
  }),
}));

// Retained from main: external virtualizer and measured-scroll policy contracts.
// This is not native layout/focus proof. Product reader workflows live in
// transcript.test.tsx; Electron suites own real scrolling and selection.
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

describe("Transcript virtualizer scroll-owner boundary", () => {
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
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    scrollToIndex.mockReset();
    cancelScrollToIndex.mockClear();
    virtualizedLifecycle.mockClear();
    virtualizedProps.current = undefined;
  });

  afterEach(() => {
    act(() => root.unmount());
    fixture[Symbol.dispose]();
    container.remove();
    vi.unstubAllGlobals();
  });

  it("opens a loaded session at the bottom before revealing it, without enabling followOutput", () => {
    const parts: UiPart[] = [
      { id: "assistant-1", kind: "text", role: "assistant", text: "First", status: "complete" },
      { id: "assistant-2", kind: "text", role: "assistant", text: "Latest", status: "complete" },
    ];

    act(() => root.render(<Transcript sessionId="session-1" parts={parts} />));

    expect(virtualizedProps.current?.initialTopMostItemIndex).toEqual({
      index: "LAST",
      align: "end",
    });
    expect(virtualizedProps.current?.followOutput).toBe(false);
    // The transcript scroll owner anchors the reader instead of Virtuoso.
    expect(virtualizedProps.current?.skipUpwardScrollCompensation).toBe(true);
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
    scroller.getBoundingClientRect = () => ({ top: 0, bottom: 600, height: 600 }) as DOMRect;
    scroller.style.setProperty("--composer-dock-height", "100px");
    item.getBoundingClientRect = () => ({ top: 900, bottom: 1000, height: 100 }) as DOMRect;
    act(() => render({ messageId: "assistant-1", origin: "keyboard", revision: 1 }));
    expect(scroller.scrollTop).toBe(516);
  });

  it("restores each selected session by its visible message anchor", () => {
    const first: UiPart = {
      id: "assistant-1",
      kind: "text",
      role: "assistant",
      text: "First session",
      status: "complete",
    };
    const second: UiPart = {
      id: "assistant-2",
      kind: "text",
      role: "assistant",
      text: "Second session",
      status: "complete",
    };

    act(() => root.render(<Transcript sessionId="session-1" parts={[first]} />));
    act(() => {
      const transcript = container.querySelector<HTMLElement>(".transcript");
      const item = transcript?.querySelector<HTMLElement>('[data-slot="transcript-item"]');
      if (!transcript || !item) return;
      Object.defineProperties(transcript, {
        clientHeight: { configurable: true, value: 400 },
        scrollHeight: { configurable: true, value: 1_000 },
      });
      transcript.getBoundingClientRect = () => ({ top: 0 }) as DOMRect;
      item.getBoundingClientRect = () => ({ top: -40, bottom: 60 }) as DOMRect;
      // The reader leaves the bottom, then rests mid-transcript.
      transcript.scrollTop = 600;
      transcript.dispatchEvent(new Event("scroll"));
      transcript.dispatchEvent(new WheelEvent("wheel", { deltaY: -1, bubbles: true }));
      transcript.scrollTop = 240;
      transcript.dispatchEvent(new Event("scroll"));
    });
    act(() => root.render(<Transcript sessionId="session-2" parts={[second]} />));
    act(() => root.render(<Transcript sessionId="session-1" parts={[first]} />));

    expect(virtualizedLifecycle.mock.calls).toEqual([
      ["mounted"],
      ["unmounted"],
      ["mounted"],
      ["unmounted"],
      ["mounted"],
    ]);
    expect(virtualizedProps.current?.initialTopMostItemIndex).toEqual({
      index: 0,
      align: "start",
      offset: 40,
    });
  });
});
