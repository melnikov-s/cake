/** @vitest-environment jsdom */
import { cleanup, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TurnId } from "../../../src/contracts/conversations/conversation-data";
import type { UiPart } from "../../../src/contracts/conversations/session-contract";
import type { Client } from "../../../src/renderer/client/Client";
import {
  formatSessionDigestReminder,
  sessionDigestParts,
} from "../../../src/contracts/cake-chats/session-digest-reminder";
import {
  renderConversationSession,
  originalUserPart,
  workingAssistantPart,
  queuedUserPart,
} from "./conversation-session-workflow-fixture";

afterEach(cleanup);
const report: UiPart = {
  id: "agent-update-result",
  renderKey: "agent-update-result",
  kind: "text",
  role: "user",
  status: "complete",
  text: "Worker found the source",
  renderAs: "markdown",
  agentSource: {
    title: "Investigate transport",
    href: "cake://subagent/parent/30000000-0000-4000-8000-000000000001?message=result",
  },
};
const notice: UiPart = {
  id: "passive-fyi",
  renderKey: "passive-fyi",
  kind: "text",
  role: "user",
  status: "complete",
  text: "Progress is available",
  crossSession: {
    version: 1,
    messageId: "10000000-0000-4000-8000-000000000001",
    threadId: "20000000-0000-4000-8000-000000000001",
    sequence: 1,
    expectsResponse: false,
    sender: { sessionId: "sender", title: "Other session", kind: "project-session" },
  },
};
const digest = sessionDigestParts(
  formatSessionDigestReminder({
    lines: [
      {
        reference: "child",
        sessionId: "child",
        title: "Completed task",
        status: "completed",
        summary: "Ready to review",
      },
    ],
    receiptIds: ["digest"],
  })!,
)[0]!;
const admitted = [report, notice, digest];
const pending = admitted.map((part) => ({ ...part, pendingIncoming: true }));

describe.each(["project", "project-chat", "cake-chat"] as const)(
  "%s pending incoming",
  (profile) => {
    it.each([false, true])(
      "appears without send (running=%s), stays mounted and ordered on admission, and never reads sources or acknowledges",
      async (running) => {
        const inspect = vi.fn<Client["sessionChats"]["inspect"]>();
        const prompt = vi.fn<Client["sessionChats"]["prompt"]>(async () => {
          // The inbox event can beat Pi's usual transcript update; the admitted entry
          // must bridge that gap and remain the same DOM surface.
          fixture.incoming(admitted);
          return TurnId.make("10000000-0000-4000-8000-000000000001");
        });
        using fixture = renderConversationSession(profile, { sessionChats: { prompt, inspect } }, [
          originalUserPart,
          workingAssistantPart,
        ]);
        fixture.publish({ streaming: running });
        fixture.incoming(pending);
        await screen.findByText("Worker found the source");
        await screen.findByText("Progress is available");
        await screen.findByText("Completed task");
        const markers = pending.map((part) =>
          document.querySelector(`[data-part-id="${part.id}"]`)!,
        );
        for (const marker of markers) {
          expect(marker.getAttribute("data-pending-incoming")).toBe("true");
          expect(marker.classList.contains("opacity-50")).toBe(true);
        }
        expect(prompt).not.toHaveBeenCalled();
        expect(inspect).not.toHaveBeenCalled();
        const input = screen.getByRole("combobox", { name: fixture.inputLabel });
        await fixture.user.type(input, "Next real question");
        await fixture.user.click(screen.getByRole("button", { name: "Send" }));
        await waitFor(() => expect(prompt).toHaveBeenCalledOnce());
        for (let i = 0; i < admitted.length; i++) {
          const marker = document.querySelector(`[data-part-id="${admitted[i]!.id}"]`);
          expect(marker).toBe(markers[i]);
          expect(marker?.getAttribute("data-pending-incoming")).toBeNull();
          expect(marker?.classList.contains("opacity-50")).toBe(false);
        }
        fixture.publish({
          parts: [
            originalUserPart,
            ...admitted,
            workingAssistantPart,
            queuedUserPart("Next real question"),
          ],
          streaming: running,
        });
        // Promotion must not pull incoming content back before the assistant already
        // visible at arrival. History retains its established reading order.
        const ids = [...document.querySelectorAll("[data-part-id]")].map((element) =>
          element.getAttribute("data-part-id"),
        );
        expect(ids.indexOf("assistant-part")).toBeLessThan(ids.indexOf(report.id));
        for (let i = 0; i < admitted.length; i++)
          expect(document.querySelector(`[data-part-id="${admitted[i]!.id}"]`)).toBe(markers[i]);
        expect(screen.getAllByText("Worker found the source")).toHaveLength(1);
        expect(inspect).not.toHaveBeenCalled();
      },
    );

    it("removes a withdrawn inbox preview without manufacturing a normal transcript message", async () => {
      using fixture = renderConversationSession(profile, {}, [originalUserPart]);
      fixture.incoming(pending);
      await screen.findByText("Worker found the source");
      fixture.incoming([]);
      expect(screen.queryByText("Worker found the source")).toBeNull();
      fixture.publish({ parts: [originalUserPart] });
      expect(screen.queryByText("Worker found the source")).toBeNull();
    });
  },
);
