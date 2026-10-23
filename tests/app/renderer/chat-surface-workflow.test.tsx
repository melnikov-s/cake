/** @vitest-environment jsdom */
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TurnId } from "../../../src/contracts/conversations/conversation-data";
import type { UiPart } from "../../../src/contracts/conversations/session-contract";
import type { Client } from "../../../src/renderer/client/Client";
import { changedFile, chatSessionId, renderChatSurface } from "./chat-surface-workflow-fixture";

afterEach(cleanup);

// These prove service payloads and rendered preferences, not native typing/focus,
// portal placement, or scrolling. Existing Electron suites own those contracts.
describe("Shared Chat surface workflows", () => {
  it.each([
    { text: "# Heading", markdown: true },
    { text: "First line\nSecond line", markdown: false },
  ])(
    "detects message formatting on send and lets the user change the saved presentation ($markdown)",
    async ({ text, markdown }) => {
      const prompt = vi.fn<Client["sessionChats"]["prompt"]>(async () =>
        TurnId.make("10000000-0000-4000-8000-000000000001"),
      );
      const setMarkdown = vi.fn<Client["sessionChats"]["setUserMessageMarkdown"]>(
        async () => undefined,
      );
      using fixture = renderChatSurface({
        client: { sessionChats: { prompt, setUserMessageMarkdown: setMarkdown } },
      });
      const send = screen.getByRole("button", { name: "Send" });
      expect(send).toHaveProperty("disabled", true);
      await fixture.user.click(send);
      expect(prompt).not.toHaveBeenCalled();
      await fixture.user.type(
        screen.getByRole("combobox", { name: "Message" }),
        text.replaceAll("\n", "{Shift>}{Enter}{/Shift}"),
      );
      await fixture.user.click(send);
      await waitFor(() =>
        expect(prompt).toHaveBeenCalledWith(
          expect.objectContaining({
            sessionId: chatSessionId,
            renderUserMessageAsMarkdown: markdown,
          }),
          expect.objectContaining({ signal: expect.any(AbortSignal) }),
        ),
      );
      let message: UiPart = {
        id: "saved-user",
        entryId: "user-entry",
        kind: "text",
        role: "user",
        text,
        status: "complete",
      };
      if (markdown) message = { ...message, renderAs: "markdown" };
      fixture.publish([message]);
      if (markdown) expect(screen.getByRole("heading", { name: "Heading" })).toBeDefined();
      else expect(screen.getByText("First line Second line")).toBeDefined();
      await fixture.user.click(
        screen.getByRole("button", {
          name: markdown ? "Render as plain text" : "Render as Markdown",
        }),
      );
      await waitFor(() =>
        expect(setMarkdown).toHaveBeenCalledWith(
          { sessionId: chatSessionId, entryId: "user-entry", renderAsMarkdown: !markdown },
          expect.objectContaining({ signal: expect.any(AbortSignal) }),
        ),
      );
      expect(
        screen.getByRole("button", {
          name: markdown ? "Render as Markdown" : "Render as plain text",
        }),
      ).toBeDefined();
      if (markdown) {
        expect(screen.queryByRole("heading", { name: "Heading" })).toBeNull();
        expect(screen.getByText("# Heading")).toBeDefined();
      }
    },
  );

  it("retains expanded changed files until a new period of work begins, without closing a user's expansion during that work", async () => {
    using fixture = renderChatSurface({ parts: [changedFile] });
    const files = screen.getByRole("region", { name: "Changed Files" });
    const trigger = within(files).getByRole("button", { name: "Changed Files 1 file" });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    await fixture.user.click(trigger);
    expect(within(files).getByText("src/one.ts")).toBeDefined();
    fixture.publish([changedFile]);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    fixture.publish([changedFile], true);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    await fixture.user.click(trigger);
    fixture.publish([changedFile], true);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    fixture.publish([changedFile]);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    fixture.publish([changedFile], true);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("opens only diff-bearing work logs in Diff/Compact mode, allows a manual override, and resets it when expansion changes", async () => {
    using fixture = renderChatSurface({
      parts: [
        { id: "reasoning", kind: "reasoning", text: "A plan", status: "complete" },
        {
          id: "answer",
          kind: "text",
          role: "assistant",
          text: "Applying the plan",
          status: "complete",
        },
        changedFile,
      ],
    });
    await fixture.user.click(screen.getByRole("button", { name: "Work log display options" }));
    await fixture.user.click(screen.getByRole("button", { name: "Diff view mode" }));
    await fixture.user.click(screen.getByRole("button", { name: "Compact work logs" }));
    const groups = screen.getAllByText("Work log", { exact: true }).map((label) => {
      const details = label.closest("details");
      if (!details) throw new Error("Missing work log disclosure");
      return details;
    });
    expect(groups.map((group) => group.open)).toEqual([false, true]);
    expect(screen.getByRole("region", { name: "File changes to src/one.ts" })).toBeDefined();
    // Dismiss the menu before using the real transcript disclosure.
    await fixture.user.click(screen.getByRole("button", { name: "Work log display options" }));
    const summary = groups[0]!.querySelector("summary");
    if (!summary) throw new Error("Missing reasoning work log summary");
    await fixture.user.click(summary);
    expect(groups.map((group) => group.open)).toEqual([true, true]);
    await fixture.user.click(screen.getByRole("button", { name: "Work log display options" }));
    await fixture.user.click(screen.getByRole("button", { name: "Collapsed work logs" }));
    expect(groups.map((group) => group.open)).toEqual([false, false]);
    await fixture.user.click(screen.getByRole("button", { name: "Compact work logs" }));
    expect(groups.map((group) => group.open)).toEqual([false, true]);
  });

  it("animates only live transcript arrivals, not initial history or streaming updates", () => {
    const initial: UiPart = {
      id: "initial",
      kind: "text",
      role: "assistant",
      text: "Existing message",
      status: "complete",
    };
    using fixture = renderChatSurface({ parts: [initial] });
    expect(
      screen.getByText("Existing message").closest('[data-slot="transcript-item"]')?.className,
    ).not.toContain("motion-safe:animate-arrive");

    const arriving: UiPart = {
      id: "arriving",
      renderKey: "turn-1:text:0",
      kind: "text",
      role: "assistant",
      text: "Hello",
      status: "streaming",
    };
    fixture.publish([initial, arriving], true);
    expect(screen.getByText("Hello").closest('[data-slot="transcript-item"]')?.className).toContain(
      "motion-safe:animate-arrive",
    );
    expect(
      screen.getByText("Existing message").closest('[data-slot="transcript-item"]')?.className,
    ).not.toContain("motion-safe:animate-arrive");

    // Streaming growth and final settlement keep the same renderKey and entrance class.
    fixture.publish([
      initial,
      { ...arriving, id: "settled", text: "Hello world", status: "complete" },
    ]);
    expect(
      screen.getByText("Hello world").closest('[data-slot="transcript-item"]')?.className,
    ).toContain("motion-safe:animate-arrive");
  });
});
