/** @vitest-environment jsdom */
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TurnId } from "../../../src/contracts/conversations/conversation-data";
import type { Client } from "../../../src/renderer/client/Client";
import {
  lifecycleSelectionThread,
  renderProjectSelectionLifecycle,
  renderResolvedProjectLifecycle,
} from "./project-session-lifecycle-fixture";

afterEach(cleanup);
function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

it("restores an archived project session and waits for a fresh projection before delivering a prompt or model command", async () => {
  for (const command of ["Continue", "/model openai/gpt-5"]) {
    const restoring = deferred<void>();
    const restore = vi.fn<Client["projectSessions"]["restore"]>(() => restoring.promise);
    const prompt = vi.fn<Client["sessionChats"]["prompt"]>(async () =>
      TurnId.make("10000000-0000-4000-8000-000000000002"),
    );
    const setModel = vi.fn<Client["sessionChats"]["setModel"]>(async () => undefined);
    using fixture = renderResolvedProjectLifecycle({
      projectSessions: { restore },
      sessionChats: { prompt, setModel },
    });
    await fixture.user.type(screen.getByRole("combobox", { name: "Message" }), command);
    await fixture.user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(restore).toHaveBeenCalledOnce());
    expect(restore).toHaveBeenCalledWith(
      { sessionId: "resolved", workingDirectory: "/project" },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(prompt).not.toHaveBeenCalled();
    expect(setModel).not.toHaveBeenCalled();
    await act(async () => restoring.resolve());
    await fixture.publishRestoredCatalog();
    // Catalog restoration alone does not prove that the conversation runtime is ready.
    expect(prompt).not.toHaveBeenCalled();
    expect(setModel).not.toHaveBeenCalled();
    await fixture.publishFreshConversation();
    if (command === "Continue") {
      await waitFor(() => expect(prompt).toHaveBeenCalledOnce());
      expect(prompt).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: "resolved", text: "Continue" }),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      await waitFor(() =>
        expect(screen.getByRole("combobox", { name: "Message" })).toHaveProperty("value", ""),
      );
      expect(setModel).not.toHaveBeenCalled();
    } else {
      await waitFor(() => expect(setModel).toHaveBeenCalledOnce());
      expect(setModel).toHaveBeenCalledWith(
        { sessionId: "resolved", provider: "openai", modelId: "gpt-5" },
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      expect(screen.getByRole("combobox", { name: "Message" })).toHaveProperty("value", "");
      expect(prompt).not.toHaveBeenCalled();
    }
  }
});

it.each([false, true])(
  "bridges the selection draft until the sidecar links, without reopening a panel closed before creation completes (closed: %s)",
  async (closed) => {
    const pending = deferred<Awaited<ReturnType<Client["discussionSessions"]["start"]>>>();
    const start = vi.fn<Client["discussionSessions"]["start"]>(() => pending.promise);
    using fixture = renderProjectSelectionLifecycle(start);
    const panel = screen.getByRole("complementary", { name: "Side chat" });
    const input = within(panel).getByRole("combobox", { name: "Message about selected text" });
    await fixture.user.type(input, "Why this?");
    await fixture.user.click(within(panel).getByRole("button", { name: "Send" }));
    await waitFor(() => expect(start).toHaveBeenCalledOnce());
    expect(start).toHaveBeenCalledWith(
      {
        parentSessionId: "parent",
        workingDirectory: "/project",
        anchor: lifecycleSelectionThread.anchor,
        text: "Why this?",
        annotations: [],
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    if (closed)
      await fixture.user.click(within(panel).getByRole("button", { name: "Close Side chat" }));
    await act(async () =>
      pending.resolve({
        turnId: TurnId.make("10000000-0000-4000-8000-000000000001"),
        thread: lifecycleSelectionThread,
      }),
    );
    await fixture.publishThread(lifecycleSelectionThread);
    if (closed) {
      expect(screen.queryByRole("complementary", { name: "Side chat" })).toBeNull();
    } else {
      expect(within(panel).getByRole("combobox", { name: "Message about selected text" })).toBe(
        input,
      );
      await fixture.user.type(input, "Again?");
      expect(within(panel).getByRole("button", { name: "Send" })).toHaveProperty("disabled", true);
      expect(start).toHaveBeenCalledOnce();
    }
    await fixture.publishThread({
      ...lifecycleSelectionThread,
      sidecarSessionId: "sidecar-selection",
    });
    if (closed) {
      expect(screen.queryByRole("complementary", { name: "Side chat" })).toBeNull();
      expect(screen.getByRole("combobox", { name: "Message" })).toBeDefined();
    } else {
      expect(
        within(panel).getByRole("combobox", { name: "Reply to selection side chat" }),
      ).toBeDefined();
      expect(
        within(panel).queryByRole("combobox", { name: "Message about selected text" }),
      ).toBeNull();
      expect(within(panel).getByText("Selection")).toBeDefined();
    }
  },
);
