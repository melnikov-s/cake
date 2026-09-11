/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatTextMessage } from "../../../src/renderer/components/chat-message";
import { describeScheduledOrigin } from "../../../src/utils/scheduled-message-time";

const origin = {
  version: 1 as const,
  id: "8de1a807-dc99-49ee-8d35-7a3ed20bef06",
  createdAt: "2026-09-04T11:59:00.000Z",
  sendAt: "2026-09-04T12:02:00.000Z",
  createdBySessionId: "session-1",
};

describe("scheduled message presentation", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it("labels a delivered scheduled message with when it was scheduled and sent", () => {
    const expected = describeScheduledOrigin(origin);
    act(() => {
      root.render(
        <ChatTextMessage
          part={{
            id: "message-1",
            kind: "text",
            role: "user",
            text: "Check the build",
            status: "complete",
            scheduled: origin,
          }}
        />,
      );
    });

    const label = container.querySelector<HTMLElement>('[data-slot="message-label"]');
    expect(label?.textContent).toBe(`You · ${expected.summary}`);
    expect(label?.title).toBe(expected.detail);
    expect(label?.querySelector("svg")).not.toBeNull();
    expect(expected.summary).toMatch(/^scheduled \d{1,2}:\d{2}.* · sent \d{1,2}:\d{2}/);
  });

  it("keeps the plain label for a typed message", () => {
    act(() => {
      root.render(
        <ChatTextMessage
          part={{
            id: "message-2",
            kind: "text",
            role: "user",
            text: "Check the build",
            status: "complete",
          }}
        />,
      );
    });

    const label = container.querySelector<HTMLElement>('[data-slot="message-label"]');
    expect(label?.textContent).toBe("You");
    expect(label?.title).toBe("");
    expect(label?.querySelector("svg")).toBeNull();
  });
});
