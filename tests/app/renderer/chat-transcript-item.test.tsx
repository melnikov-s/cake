/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UiPart } from "../../../src/ipc/session-contract";
import type { CanonicalTranscriptBehavior } from "../../../src/renderer/components/chat-message";
import type { ChatStore } from "../../../src/renderer/stores/ChatStore";

const { transcriptPartRender } = vi.hoisted(() => ({ transcriptPartRender: vi.fn() }));

vi.mock("../../../src/renderer/components/chat-transcript-part", () => ({
  TranscriptPart: ({ part }: { part: UiPart }) => {
    transcriptPartRender(part.id);
    return <div>{part.id}</div>;
  },
}));
vi.mock("../../../src/renderer/components/work-log-activity-group", () => ({
  ActivityGroup: () => null,
}));
vi.mock("../../../src/renderer/components/chat-transcript-elements", () => ({
  ReviewRunMessage: () => null,
}));
vi.mock("@/components/changed-files", () => ({ ChangedFiles: () => null }));
vi.mock("@/components/ui/loading-state", () => ({ LoadingState: () => null }));

import { ChatTranscriptItem } from "../../../src/renderer/components/chat-transcript-item";

describe("ChatTranscriptItem", () => {
  let container: HTMLDivElement;
  let root: Root;

  const behavior = {
    store: {
      transcriptInteraction: { setChangedFilesOpen: vi.fn() },
    } as unknown as ChatStore,
    renderChat: () => null,
  } as CanonicalTranscriptBehavior;

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    transcriptPartRender.mockClear();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("does not re-render a settled item when another message streams", () => {
    const settled: UiPart = {
      id: "settled",
      kind: "text",
      role: "assistant",
      text: "Done",
      status: "complete",
    };
    const streaming: UiPart = {
      id: "streaming",
      kind: "text",
      role: "assistant",
      text: "One",
      status: "streaming",
    };
    const render = (parts: UiPart[]) =>
      root.render(
        <ChatTranscriptItem
          item={settled}
          index={0}
          errorFollowsUser={false}
          parts={parts}
          behavior={behavior}
          changedFilesOpen={false}
          loadingStartedAt={undefined}
        />,
      );

    act(() => render([settled, streaming]));
    act(() => render([settled, { ...streaming, text: "One two" }]));

    expect(transcriptPartRender).toHaveBeenCalledTimes(1);
    expect(transcriptPartRender).toHaveBeenCalledWith("settled");
  });
});
