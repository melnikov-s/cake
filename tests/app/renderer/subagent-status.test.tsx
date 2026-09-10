/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { applySnapshot, createStore, mount } from "r-state-tree";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Session } from "../../../src/renderer/models/Session";
import { SubagentStatus } from "../../../src/renderer/components/subagent-status";
import { SubagentActivityStore } from "../../../src/renderer/stores/SubagentActivityStore";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("SubagentStatus", () => {
  let container: HTMLDivElement;
  let root: Root;
  let store: SubagentActivityStore;
  let model: Session;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    model = Session.create({ sessionId: "parent" });
    store = mount(
      createStore(SubagentActivityStore, {
        sessionId: "parent",
        model,
        parts: () => [],
      }),
    );
  });

  afterEach(() => {
    act(() => root.unmount());
    store[Symbol.dispose]();
    model[Symbol.dispose]();
    container.remove();
  });

  it("opens an active handle's unified log from the persistent running count", () => {
    const handleId = crypto.randomUUID();
    act(() => {
      applySnapshot(model, {
        subagentActivities: [
          {
            parentSessionId: "parent",
            anchorPartId: "spawn",
            handleId,
            revision: 1,
            task: "Inspect activity projection",
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
        ],
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

    expect(document.body.querySelector('[role="dialog"][aria-label="Subagent"]')).not.toBeNull();
    expect(document.body.querySelector('[data-testid="subagent-log"]')?.textContent).toBe(
      "child-read",
    );

    act(() => {
      applySnapshot(model, { releasedSubagentHandleIds: [handleId] });
    });
    expect(container.querySelector('button[aria-label="1 subagents running"]')).toBeNull();
    expect(document.body.querySelector('[role="dialog"][aria-label="Subagent"]')).not.toBeNull();
    expect(document.body.textContent).toContain("Released");
  });
});
