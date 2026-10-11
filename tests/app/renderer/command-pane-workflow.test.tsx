/** @vitest-environment jsdom */
import { act, cleanup, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Client } from "../../../src/renderer/client/Client";
import { renderCommandPane } from "./command-pane-fixture";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function messageDraft() {
  const input = screen.getByRole("combobox", { name: "Message" });
  if (!(input instanceof HTMLTextAreaElement)) throw new Error("Expected the message textarea");
  return input.value;
}

afterEach(cleanup);

describe("Command pane tree navigation workflow", () => {
  // These exercise rendered state and service payloads, not native focus or portal behavior.
  it("summarizes with trimmed custom focus and restores the full user prompt only after navigation completes", async () => {
    const pending = deferred();
    const navigate = vi.fn<Client["projectSessions"]["navigate"]>(() => pending.promise);
    using fixture = renderCommandPane({ projectSessions: { navigate } });

    await fixture.user.click(screen.getByRole("button", { name: "user Original prompt…" }));
    expect(screen.getByRole("button", { name: "No summary" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    await fixture.user.click(screen.getByRole("button", { name: "Summarize with custom focus" }));
    await fixture.user.type(
      screen.getByRole("textbox", { name: "Summary focus" }),
      "  Preserve the API decisions  ",
    );
    await fixture.user.click(screen.getByRole("button", { name: "Continue here" }));

    await waitFor(() => expect(navigate).toHaveBeenCalledOnce());
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(messageDraft()).toBe("");
    expect(navigate).toHaveBeenCalledWith(
      {
        sessionId: "source",
        entryId: "user-entry",
        summarize: true,
        customInstructions: "Preserve the API decisions",
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );

    await act(async () => pending.resolve());
    await waitFor(() =>
      expect(messageDraft()).toBe("Original prompt with the full API requirements"),
    );
  });

  it("resumes from an assistant response without a summary or replacing the existing draft", async () => {
    const navigate = vi.fn<Client["projectSessions"]["navigate"]>(async () => undefined);
    using fixture = renderCommandPane({ projectSessions: { navigate } });

    await fixture.user.type(screen.getByRole("combobox", { name: "Message" }), "Next question");
    await fixture.user.click(
      screen.getByRole("button", { name: "assistant API decisions recorded" }),
    );
    expect(screen.getByRole("button", { name: "No summary" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    await fixture.user.click(screen.getByRole("button", { name: "Continue here" }));

    await waitFor(() => expect(navigate).toHaveBeenCalledOnce());
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(navigate).toHaveBeenCalledWith(
      { sessionId: "source", entryId: "assistant-entry", summarize: false },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(messageDraft()).toBe("Next question");
  });
});
