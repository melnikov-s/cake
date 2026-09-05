/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { ChatTextMessage } from "../../../src/renderer/components/chat-message";

const metadata = {
  version: 1 as const,
  messageId: "f6debbbd-ced1-4a12-b0f7-fb60c292c623",
  threadId: "8358c2b7-bd3c-42ee-9fec-fcb726b66c18",
  sequence: 2,
  maxMessages: 15,
  sender: {
    kind: "project-session" as const,
    sessionId: "source-session",
    title: "API review",
    projectName: "Cake",
    workingDirectory: "/projects/cake",
  },
};

describe("cross-session message presentation", () => {
  it("labels session-authored messages separately from user-authored messages", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => {
      root.render(
        <ChatTextMessage
          part={{
            id: "message-1",
            kind: "text",
            role: "user",
            text: "A reply from another session",
            status: "complete",
            crossSession: metadata,
          }}
        />,
      );
    });

    expect(container.textContent).toContain("API review · session message · 2/15");
    expect(container.textContent).not.toContain("YouA reply");
    act(() => root.unmount());
    container.remove();
  });
});
