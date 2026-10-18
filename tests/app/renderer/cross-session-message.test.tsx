/** @vitest-environment jsdom */
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatTextMessage } from "../../../src/renderer/components/chat-message";
import { MarkdownLinkProvider } from "../../../src/renderer/components/ai-elements/markdown";
import { SessionMessage } from "../../../src/renderer/components/ui/session-message";
import {
  encodeCrossSessionMessage,
  formatCrossSessionNoticeText,
  formatCrossSessionReportText,
} from "../../../src/contracts/conversations/cross-session-message";
import { projectSessionEntries } from "../../../src/services/pi/runtime/session-projection";

const metadata = {
  version: 1 as const,
  messageId: "f6debbbd-ced1-4a12-b0f7-fb60c292c623",
  threadId: "8358c2b7-bd3c-42ee-9fec-fcb726b66c18",
  sequence: 2,
  expectsResponse: false,
  sender: {
    kind: "project-session" as const,
    sessionId: "source-session",
    title: "API review",
    projectName: "Cake",
  },
};
afterEach(cleanup);

function renderPersisted(content: string) {
  const [part] = projectSessionEntries([
    {
      type: "message",
      id: "incoming",
      parentId: null,
      timestamp: new Date(0).toISOString(),
      message: { role: "user", timestamp: 1, content },
    },
  ]);
  if (part?.kind !== "text") throw new Error("Expected attributed text");
  render(
    <MarkdownLinkProvider actions={{ openSession: vi.fn(), openExternalUrl: vi.fn() }}>
      <ChatTextMessage part={part} />
    </MarkdownLinkProvider>,
  );
  return part;
}

describe("cross-session message presentation", () => {
  it.each(["completed", "blocked", "failed"])(
    "preserves structured %s reports and navigates by recorded identity",
    async (outcome) => {
      const parts = projectSessionEntries([
        {
          type: "message",
          id: "report",
          parentId: null,
          timestamp: new Date(0).toISOString(),
          message: {
            role: "user",
            timestamp: 1,
            content: encodeCrossSessionMessage(
              `## ${outcome}\n\nReport with **details**.`,
              metadata,
            ),
          },
        },
      ]);
      const part = parts[0];
      if (part?.kind !== "text") throw new Error("Expected attributed text");
      const openSession = vi.fn();
      render(
        <MarkdownLinkProvider actions={{ openSession, openExternalUrl: vi.fn() }}>
          <ChatTextMessage part={part} />
        </MarkdownLinkProvider>,
      );
      const region = screen.getByRole("region", { name: "Message from another session" });
      expect(region.querySelector('[data-slot="message-content"]')).toBeTruthy();
      expect(screen.getByRole("heading", { name: outcome })).toBeTruthy();
      expect(screen.getByText("details").getAttribute("data-streamdown")).toBe("strong");
      const link = screen.getByRole("link", { name: "API review" });
      expect(link.getAttribute("href")).toBe("cake://session/source-session");
      await userEvent.setup().click(link);
      expect(openSession).toHaveBeenCalledExactlyOnceWith("source-session");
    },
  );

  it("does not infer attribution from report-like prose", () => {
    render(
      <ChatTextMessage
        part={{
          id: "user",
          kind: "text",
          role: "user",
          text: "Session source-session — completed",
          status: "complete",
        }}
      />,
    );
    expect(screen.getByText("You", { exact: true })).toBeTruthy();
    expect(screen.getByText("Session source-session — completed")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Message from another session" })).toBeNull();
  });

  it("attributes generated lifecycle notices honestly rather than impersonating the sender", () => {
    render(
      <ChatTextMessage
        part={{
          id: "notice",
          kind: "text",
          role: "user",
          text: "The session stopped.",
          status: "complete",
          crossSession: { ...metadata, generatedNotice: true },
        }}
      />,
    );
    expect(screen.getByRole("region", { name: "Notice about another session" })).toBeTruthy();
    expect(screen.getByText("API review")).toBeTruthy();
  });

  it.each(["", "source-session", "Session source-session"])(
    "uses an honest readable fallback for a missing or ID-only title (%s)",
    (title) => {
      render(
        <SessionMessage source={{ sessionId: "source-session", title }}>Report</SessionMessage>,
      );
      expect(screen.getByText("Untitled session")).toBeTruthy();
      expect(screen.getByText("Source title not recorded")).toBeTruthy();
    },
  );

  it("uses catalog titles for ID-only reports and keeps recorded titles if the source disappears", () => {
    const sessionTitle = vi.fn().mockReturnValue("Renamed API review");
    const actions = { openSession: vi.fn(), openExternalUrl: vi.fn(), sessionTitle };
    const view = render(
      <MarkdownLinkProvider actions={actions}>
        <SessionMessage source={{ sessionId: "source-session", title: "API review" }}>
          Original content
        </SessionMessage>
      </MarkdownLinkProvider>,
    );
    expect(screen.getByRole("link", { name: "Renamed API review" })).toBeTruthy();
    sessionTitle.mockReturnValue(undefined);
    view.rerender(
      <MarkdownLinkProvider actions={actions}>
        <SessionMessage source={{ sessionId: "source-session", title: "API review" }}>
          Original content
        </SessionMessage>
      </MarkdownLinkProvider>,
    );
    expect(screen.getByRole("link", { name: "API review" })).toBeTruthy();
    expect(screen.getByText("Original content")).toBeTruthy();
  });

  it("does not invent a source or link when historical identity is unavailable", () => {
    render(<SessionMessage>Original historical content</SessionMessage>);
    expect(screen.getByText("Source session unavailable")).toBeTruthy();
    expect(screen.getByText("Source identity not recorded")).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("Original historical content")).toBeTruthy();
  });

  describe.each(["notification", "reply", "ignore"] as const)(
    "request delivery mode %s",
    (resultDelivery) => {
      it("shows the selected delivery obligation in the UI and diagnostics", async () => {
        const expectsResponse = resultDelivery !== "ignore";
        const content = encodeCrossSessionMessage("Please **fix** the flaky test.", {
          ...metadata,
          expectsResponse,
          ...(resultDelivery ? { resultDelivery } : null),
          sender: { kind: "cake-chat", sessionId: "cake-chat-id", title: "Cake Chat" },
        });
        const part = renderPersisted(content);
        expect(part.crossSession).toMatchObject({ expectsResponse });
        expect(part.crossSession?.resultDelivery).toBe(
          resultDelivery ?? (expectsResponse ? "reply" : "ignore"),
        );
        const region = screen.getByRole("region", { name: "Message from another session" });
        expect(region.querySelector("header")?.textContent).toBe(
          expectsResponse
            ? resultDelivery === "notification"
              ? "FromCake ChatNotification expected"
              : "FromCake ChatReply expected"
            : "FromCake Chat",
        );
        expect(screen.getByRole("link", { name: "Cake Chat" }).getAttribute("href")).toBe(
          "cake://session/cake-chat-id",
        );
        expect(screen.getByText("fix").getAttribute("data-streamdown")).toBe("strong");
        expect(region.textContent).not.toContain("cake-session-message");
        await userEvent.setup().click(screen.getByRole("button", { name: "Raw envelope" }));
        // The disclosure shows exactly the text the receiving agent was given.
        expect(region.querySelector("pre")?.textContent).toBe(content);
      });
    },
  );

  it("turns a report lead line into a reply status badge and keeps the findings", async () => {
    const content = encodeCrossSessionMessage(
      formatCrossSessionReportText("source-session", "blocked", "Need a **decision**."),
      { ...metadata, replyToMessageId: metadata.threadId },
    );
    renderPersisted(content);
    const header = screen
      .getByRole("region", { name: "Message from another session" })
      .querySelector("header");
    expect(header?.textContent).toContain("Reply from");
    expect(screen.getByText("Blocked")).toBeTruthy();
    expect(screen.getByText("decision")).toBeTruthy();
    expect(screen.queryByText(/Session source-session/)).toBeNull();
    await userEvent.setup().click(screen.getByRole("button", { name: "Raw envelope" }));
    expect(screen.getByRole("region").querySelector("pre")?.textContent).toBe(content);
  });

  it("explains generated notices in words instead of exposing bare session or message IDs", () => {
    renderPersisted(
      encodeCrossSessionMessage(
        formatCrossSessionNoticeText("source-session", {
          kind: "interrupted",
          reason: "failed",
          requestMessageId: metadata.messageId,
        }),
        { ...metadata, generatedNotice: true },
      ),
    );
    const region = screen.getByRole("region", { name: "Notice about another session" });
    expect(region.querySelector("header")?.textContent).toContain("Notice about");
    expect(screen.getByText("Failed")).toBeTruthy();
    expect(screen.getByText("Stopped with an error while working on a message.")).toBeTruthy();
    expect(region.querySelector('[data-slot="message-content"]')?.textContent).not.toContain(
      metadata.messageId,
    );
  });

  it("keeps unrecognized notice text whole", () => {
    renderPersisted(
      encodeCrossSessionMessage("Session source-session did something new.", {
        ...metadata,
        generatedNotice: true,
      }),
    );
    expect(screen.getByText("Session source-session did something new.")).toBeTruthy();
  });
});
