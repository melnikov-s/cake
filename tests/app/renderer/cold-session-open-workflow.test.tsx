/** @vitest-environment jsdom */
import { cleanup, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TurnId } from "../../../src/contracts/conversations/conversation-data";
import type { Client } from "../../../src/renderer/client/Client";
import {
  originalUserPart,
  renderConversationSession,
} from "./conversation-session-workflow-fixture";

afterEach(cleanup);

// Authority updates control initialization; these tests prove displayed history
// and form-to-service admission, not Chromium focus or native scrolling.
describe("cold Project Session history", () => {
  it("displays saved messages and holds a send until the live agent snapshot arrives", async () => {
    const prompt = vi.fn<Client["sessionChats"]["prompt"]>(async () =>
      TurnId.make("10000000-0000-4000-8000-000000000001"),
    );
    using fixture = renderConversationSession(
      "project",
      { sessionChats: { prompt } },
      [originalUserPart],
      "Preview",
    );
    expect(await screen.findByText("Original prompt", { exact: true })).toBeDefined();
    const input = screen.getByRole("combobox", { name: "Message" });
    await fixture.user.type(input, "Continue this work");
    await fixture.user.click(screen.getByRole("button", { name: "Send" }));
    expect(prompt).not.toHaveBeenCalled();
    expect(screen.getByText("Original prompt", { exact: true })).toBeDefined();

    fixture.publish({ streaming: false });
    await waitFor(() =>
      expect(prompt).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ sessionId: fixture.sessionId, text: "Continue this work" }),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      ),
    );
    await waitFor(() => expect(input).toHaveProperty("value", ""));
    expect(screen.getByText("Original prompt", { exact: true })).toBeDefined();
  });

  it("keeps readable history and the draft after initialization fails, then permits retry", async () => {
    const prompt = vi.fn<Client["sessionChats"]["prompt"]>(async () =>
      TurnId.make("10000000-0000-4000-8000-000000000002"),
    );
    using fixture = renderConversationSession(
      "project",
      { sessionChats: { prompt } },
      [originalUserPart],
      "Preview",
    );
    const input = screen.getByRole("combobox", { name: "Message" });
    await fixture.user.type(input, "Keep my instruction");
    await fixture.user.click(screen.getByRole("button", { name: "Send" }));
    fixture.failObservation("Extension initialization failed");
    expect(
      await screen.findByText("Extension initialization failed", { exact: true }),
    ).toBeDefined();
    expect(screen.getByText("Original prompt", { exact: true })).toBeDefined();
    await waitFor(() => expect(input).toHaveProperty("value", "Keep my instruction"));
    expect(prompt).not.toHaveBeenCalled();

    fixture.publish({ streaming: false });
    await fixture.user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(prompt).toHaveBeenCalledOnce());
    expect(prompt).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Keep my instruction" }),
      expect.anything(),
    );
  });

  it("retains an unsent draft when preview is replaced by live history", async () => {
    using fixture = renderConversationSession("project", {}, [originalUserPart], "Preview");
    const input = screen.getByRole("combobox", { name: "Message" });
    await fixture.user.type(input, "Still composing");
    fixture.publish({ streaming: false });
    expect(input).toHaveProperty("value", "Still composing");
    expect(screen.getByText("Original prompt", { exact: true })).toBeDefined();
    expect(screen.getByRole("button", { name: "Send" })).toHaveProperty("disabled", false);
  });
});
