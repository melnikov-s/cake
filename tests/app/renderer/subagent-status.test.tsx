/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createStore, mount } from "r-state-tree";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DesktopClient } from "../../../src/renderer/desktop-client";
import { SubagentStatus } from "../../../src/renderer/components/subagent-status";
import { SubagentActivityStore } from "../../../src/renderer/stores/SubagentActivityStore";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("SubagentStatus", () => {
  let container: HTMLDivElement;
  let root: Root;
  let store: SubagentActivityStore;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    store = mount(
      createStore(SubagentActivityStore, {
        sessionId: "parent",
        client: {
          steerSubagent: async () => undefined,
          abortSubagent: async () => undefined,
        } as unknown as DesktopClient,
        parts: () => [],
      }),
    );
  });

  afterEach(() => {
    act(() => root.unmount());
    store[Symbol.dispose]();
    container.remove();
  });

  it("opens an active handle's unified log from the persistent running count", () => {
    const handleId = crypto.randomUUID();
    act(() => {
      store.receive({
        type: "subagent-activity-received",
        activity: {
          parentSessionId: "parent",
          anchorPartId: "spawn",
          handleId,
          revision: 1,
          task: "Inspect activity projection",
          profile: "reviewer",
          status: "running",
          resolvedModel: {
            requested: "current",
            source: "current",
            provider: "test",
            modelId: "model",
            thinkingLevel: "medium",
            fallbacks: [],
          },
          fastMode: false,
          retained: false,
          streaming: true,
          parts: [
            {
              id: "child-read",
              kind: "tool",
              name: "read",
              input: "src/renderer",
              state: "running",
            },
          ],
        },
      });
      root.render(
        <SubagentStatus
          store={store}
          renderChat={(chat) => <div data-testid="subagent-log">{chat.parts[0]?.id}</div>}
        />,
      );
    });

    const status = container.querySelector<HTMLButtonElement>(
      'button[aria-label="1 subagents running"]',
    )!;
    expect(status).not.toBeNull();
    act(() => status.click());
    expect(document.body.textContent).toContain("Inspect activity projection");

    const item = [...document.body.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Inspect activity projection"),
    )!;
    act(() => item.click());

    expect(
      document.body.querySelector('[role="dialog"][aria-label="reviewer subagent"]'),
    ).not.toBeNull();
    expect(document.body.querySelector('[data-testid="subagent-log"]')?.textContent).toBe(
      "child-read",
    );

    act(() => {
      store.receive({ type: "subagent-activity-removed", parentSessionId: "parent", handleId });
    });
    expect(container.querySelector('button[aria-label="1 subagents running"]')).toBeNull();
    expect(
      document.body.querySelector('[role="dialog"][aria-label="reviewer subagent"]'),
    ).not.toBeNull();
    expect(document.body.textContent).toContain("Released");
  });
});
