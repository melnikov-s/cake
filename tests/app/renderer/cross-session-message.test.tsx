/** @vitest-environment jsdom */
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatTextMessage } from "../../../src/renderer/components/chat-message";
import { MarkdownLinkProvider } from "../../../src/renderer/components/ai-elements/markdown";
import { SessionMessage } from "../../../src/renderer/components/session-message";
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
  render(<ChatTextMessage part={part} />);
  return part;
}

// Source navigation and catalog rename/removal now use real RendererRoot providers
// and Root/Models/Stores in chat-workspace-finish-workflow.test.tsx. Keep these
// presentation/encoding variants without fake navigation or catalog callbacks.
describe("cross-session message presentation", () => {
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
    const region = screen.getByRole("region", { name: "Notice about another session" });
    expect(region.querySelector('[data-slot="response-disclosure"]')?.textContent).toBe(
      "API review",
    );
  });

  it.each(["", "source-session", "Session source-session"])(
    "uses an honest readable fallback for a missing or ID-only title (%s)",
    (title) => {
      render(
        <SessionMessage source={{ sessionId: "source-session", title }}>Report</SessionMessage>,
      );
      expect(screen.getByRole("button", { name: "Untitled session" })).toBeTruthy();
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
    expect(screen.getByRole("button", { name: "Renamed API review" })).toBeTruthy();
    sessionTitle.mockReturnValue(undefined);
    view.rerender(
      <MarkdownLinkProvider actions={actions}>
        <SessionMessage source={{ sessionId: "source-session", title: "API review" }}>
          Original content
        </SessionMessage>
      </MarkdownLinkProvider>,
    );
    expect(screen.getByRole("button", { name: "API review" })).toBeTruthy();
    expect(screen.getByText("Original content")).toBeTruthy();
  });

  it.each([
    ["cake://session/source-session", undefined],
    ["cake://session/source-session?message=original-42", "original-42"],
  ])(
    "opens href-only source attribution through Markdown navigation (%s)",
    async (href, entryId) => {
      const openSession = vi.fn();
      render(
        <MarkdownLinkProvider actions={{ openSession, openExternalUrl: vi.fn() }}>
          <SessionMessage source={{ title: "Investigation update", href }}>Findings</SessionMessage>
        </MarkdownLinkProvider>,
      );
      const link = screen.getByRole("link", { name: "Open conversation" });
      expect(link.getAttribute("href")).toBe(href);
      await userEvent.setup().click(link);
      expect(openSession.mock.calls).toEqual([
        entryId ? ["source-session", entryId] : ["source-session"],
      ]);
    },
  );

  it("opens a private worker through its public parent/handle, never a private session ID", async () => {
    const openSubagent = vi.fn();
    const openSession = vi.fn();
    render(
      <MarkdownLinkProvider actions={{ openSession, openSubagent, openExternalUrl: vi.fn() }}>
        <SessionMessage
          source={{
            title: "Review worker",
            href: "cake://subagent/parent/10000000-0000-4000-8000-000000000002",
          }}
        >
          Original worker findings
        </SessionMessage>
      </MarkdownLinkProvider>,
    );
    expect(screen.getByRole("button", { name: "Review worker" })).toBeTruthy();
    await userEvent.setup().click(screen.getByRole("link", { name: "Open conversation" }));
    expect(openSubagent).toHaveBeenCalledExactlyOnceWith(
      "parent",
      "10000000-0000-4000-8000-000000000002",
      undefined,
    );
    expect(openSession).not.toHaveBeenCalled();
  });

  it("does not invent a source or link when historical identity is unavailable", () => {
    render(<SessionMessage>Original historical content</SessionMessage>);
    expect(screen.getByRole("button", { name: "Source session unavailable" })).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("Original historical content")).toBeTruthy();
  });

  describe.each(["notification", "reply", "ignore"] as const)(
    "request delivery mode %s",
    (resultDelivery) => {
      it("shows the selected delivery obligation without exposing the envelope", () => {
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
        // One title, then the delivery badge; the title is never repeated in the body.
        expect(region.querySelector('[data-slot="response-disclosure"]')?.textContent).toBe(
          expectsResponse
            ? resultDelivery === "notification"
              ? "Cake ChatNotification expected"
              : "Cake ChatReply expected"
            : "Cake Chat",
        );
        expect(region.textContent?.match(/Cake Chat/g)).toHaveLength(1);
        expect(screen.getByRole("link", { name: "Open conversation" }).getAttribute("href")).toBe(
          "cake://session/cake-chat-id",
        );
        expect(screen.getByText("fix").getAttribute("data-streamdown")).toBe("strong");
        expect(region.textContent).not.toContain("cake-session-message");
        expect(region.textContent).not.toContain(metadata.messageId);
        expect(region.textContent).not.toContain("expectsResponse");
      });
    },
  );

  it("turns a report lead line into a reply status badge and keeps the findings", () => {
    const content = encodeCrossSessionMessage(
      formatCrossSessionReportText("source-session", "blocked", "Need a **decision**."),
      { ...metadata, replyToMessageId: metadata.threadId },
    );
    renderPersisted(content);
    expect(screen.getByRole("button", { name: "API review" }).textContent).toBe(
      "API reviewBlocked",
    );
    expect(screen.getByText("decision")).toBeTruthy();
    expect(screen.queryByText(/Session source-session/)).toBeNull();
    expect(screen.getByRole("region").textContent).not.toContain("cake-session-message");
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
    expect(screen.getByRole("button", { name: "API review" }).textContent).toBe("API reviewFailed");
    expect(screen.getByText("Stopped with an error while working on a message.")).toBeTruthy();
    expect(region.querySelector('[data-slot="message-content"]')?.textContent).not.toContain(
      metadata.messageId,
    );
  });

  it("preserves authored reply prose and links that resemble delivery scaffolding", () => {
    renderPersisted(
      encodeCrossSessionMessage(
        "## Review notes\n\nReferenced Cake messages are useful here.\n\n[My original notes](cake://session/source-session?message=notes)\n\nKeep this explanation.",
        { ...metadata, replyToMessageId: metadata.threadId },
      ),
    );
    expect(screen.getByRole("heading", { name: "Review notes" })).toBeTruthy();
    expect(screen.getByText("Referenced Cake messages are useful here.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "My original notes" }).getAttribute("href")).toBe(
      "cake://session/source-session?message=notes",
    );
    expect(screen.getByText("Keep this explanation.")).toBeTruthy();
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
