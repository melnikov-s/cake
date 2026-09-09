/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStore, mount } from "r-state-tree";
import type { UiPart } from "../../../src/ipc/session-contract";

const { renderWorkLogDiff } = vi.hoisted(() => ({ renderWorkLogDiff: vi.fn() }));

vi.mock("@/components/ai-elements/work-log-diff", () => ({
  WorkLogDiff: () => {
    renderWorkLogDiff();
    return <div aria-label="mock work-log diff" />;
  },
}));

import type { CanonicalTranscriptBehavior } from "../../../src/renderer/components/chat-message";
import { ActivityGroup } from "../../../src/renderer/components/work-log-activity-group";
import { ChatStore } from "../../../src/renderer/stores/ChatStore";

describe("ActivityGroup", () => {
  let container: HTMLDivElement;
  let root: Root;
  let store: ChatStore;

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    vi.useFakeTimers();
    renderWorkLogDiff.mockClear();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    store?.[Symbol.dispose]();
    container.remove();
    vi.useRealTimers();
  });

  it("does not rebuild a streaming diff when only elapsed time advances", async () => {
    const parts: UiPart[] = [
      {
        id: "tool-edit",
        kind: "tool",
        name: "edit",
        input: JSON.stringify({
          path: "src/app.ts",
          edits: [{ oldText: "old", newText: "new" }],
        }),
        filePath: "src/app.ts",
        state: "running",
      },
    ];
    store = mount(
      createStore(ChatStore, {
        id: () => "session-1",
        parts: () => parts,
        streaming: () => true,
        submitting: () => false,
        configuration: () => undefined,
        commands: () => [],
        placeholder: () => "",
        inputLabel: () => "Prompt",
        canSubmit: () => true,
        submit: async () => true,
      }),
    );
    store.workLogPresentation.setExpansion("expanded");
    const behavior = {
      store,
      renderChat: () => null,
    } as CanonicalTranscriptBehavior;

    await act(async () => {
      root.render(<ActivityGroup groupId="group-1" parts={parts} behavior={behavior} />);
    });
    const rendersBeforeTick = renderWorkLogDiff.mock.calls.length;
    expect(rendersBeforeTick).toBeGreaterThan(0);

    await act(async () => {
      vi.advanceTimersByTime(500);
    });

    expect(renderWorkLogDiff).toHaveBeenCalledTimes(rendersBeforeTick);
    expect(container.textContent).toContain("0.5s");
  });

  it("includes added and removed files in the work-log totals", async () => {
    const parts: UiPart[] = [
      {
        id: "tool-write",
        kind: "tool",
        name: "write",
        input: JSON.stringify({ path: "src/added.ts", content: "one\ntwo\nthree" }),
        filePath: "src/added.ts",
        state: "success",
      },
      {
        id: "tool-remove",
        kind: "tool",
        name: "remove",
        input: JSON.stringify({ path: "src/removed.ts" }),
        filePath: "src/removed.ts",
        diff: "--- a/src/removed.ts\n+++ /dev/null\n@@ -1,4 +0,0 @@\n-one\n-two\n-three\n-four",
        state: "success",
      },
    ];
    store = mount(
      createStore(ChatStore, {
        id: () => "session-1",
        parts: () => parts,
        streaming: () => false,
        submitting: () => false,
        configuration: () => undefined,
        commands: () => [],
        placeholder: () => "",
        inputLabel: () => "Prompt",
        canSubmit: () => true,
        submit: async () => true,
      }),
    );
    const behavior = {
      store,
      renderChat: () => null,
    } as CanonicalTranscriptBehavior;

    await act(async () => {
      root.render(<ActivityGroup groupId="group-1" parts={parts} behavior={behavior} />);
    });

    expect(container.querySelector("summary")?.textContent).toContain("2 edits · +3 −4");
  });
});
