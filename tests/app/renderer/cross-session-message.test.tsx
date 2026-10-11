/** @vitest-environment jsdom */
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatTextMessage } from "../../../src/renderer/components/chat-message";
import { MarkdownLinkProvider } from "../../../src/renderer/components/ai-elements/markdown";
import { SessionMessage } from "../../../src/renderer/components/ui/session-message";
import { encodeCrossSessionMessage } from "../../../src/contracts/conversations/cross-session-message";
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
});
