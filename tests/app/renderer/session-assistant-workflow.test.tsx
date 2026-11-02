/** @vitest-environment jsdom */
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TurnId } from "../../../src/contracts/conversations/conversation-data";
import { SESSION_ASSISTANT_ID } from "../../../src/contracts/cake-chats/cake-chat-identity";
import type { Client } from "../../../src/renderer/client/Client";
import { renderSessionAssistant } from "./session-assistant-workflow-fixture";
import { applyCakeChatControlUpdate } from "../../../src/renderer/reducers/CakeChatControlReducer";
import { editorLease } from "./embedded-editor-workflow-fixture";

const turnId = TurnId.make("10000000-0000-4000-8000-000000000001");
afterEach(cleanup);

// Payload/state workflows; Chromium focus/selection are verified separately in Electron.
describe("Shared companion", () => {
  it("keeps quick and right-click chat on one history, independent of a busy main agent", async () => {
    const prompt = vi.fn<Client["sessionChats"]["prompt"]>(async () => turnId);
    const orientation = vi.fn<Client["cakeChats"]["assistantContext"]>(async () => undefined);
    using f = renderSessionAssistant({
      sessionChats: { prompt },
      cakeChats: { assistantContext: orientation },
    });
    act(() => {
      f.root.workspaceSession!.model.streaming = true;
    });
    await f.user.click(screen.getByRole("button", { name: "Ask session assistant" }));
    await f.user.type(
      screen.getByRole("combobox", { name: "Ask session assistant" }),
      "Where is the plan?",
    );
    await f.user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(prompt).toHaveBeenCalledOnce());
    expect(prompt.mock.calls[0]?.[0]).toMatchObject({
      sessionId: SESSION_ASSISTANT_ID,
      text: "Where is the plan?",
      attachments: [],
    });
    expect(screen.getByRole("status", { name: "Session assistant is thinking" })).toBeDefined();
    f.settle(turnId, "In docs/plan.md.", "Where is the plan?");
    expect(await screen.findByText("In docs/plan.md.")).toBeDefined();
    await f.user.pointer({
      target: screen.getByRole("button", { name: "Ask session assistant" }),
      keys: "[MouseRight]",
    });
    const full = within(screen.getByRole("dialog", { name: "Session assistant chat" }));
    expect(full.getByText("Where is the plan?")).toBeDefined();
    expect(full.getByText("In docs/plan.md.")).toBeDefined();
    await f.user.type(full.getByRole("combobox", { name: "Message session assistant" }), "Open it");
    await f.user.click(full.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(prompt).toHaveBeenCalledTimes(2));
    expect(prompt.mock.calls[1]?.[0]).toMatchObject({
      sessionId: SESSION_ASSISTANT_ID,
      text: "Open it",
    });
    expect(orientation).toHaveBeenCalledTimes(1);
    expect(f.root.workspaceSession!.model.streaming).toBe(true);
  });

  it("routes Companion editor controls to the viewed session without prompting or interrupting its busy agent", async () => {
    const respond = vi.fn<Client["cakeChats"]["respondControl"]>(async () => undefined);
    const open = vi.fn<Client["vscode"]["open"]>(async () => editorLease("a"));
    const reveal = vi.fn<Client["vscode"]["reveal"]>(async () => ({
      outcome: { view: "file" },
      locations: [],
    }));
    const prompt = vi.fn<Client["sessionChats"]["prompt"]>();
    const abort = vi.fn<Client["sessionChats"]["abort"]>();
    using f = renderSessionAssistant({
      cakeChats: { respondControl: respond },
      sessionChats: { prompt, abort },
      filesystem: { prepareFileLocation: async ({ location }) => ({ viewer: "vscode", location }) },
      vscode: {
        open,
        reveal,
        updateAnnotations: async () => undefined,
        updateSelectionHighlights: async () => undefined,
        setTheme: async () => undefined,
      },
    });
    act(() => {
      f.root.workspaceSession!.model.streaming = true;
    });
    await f.user.click(screen.getByRole("button", { name: "Ask session assistant" }));
    f.root.applicationControlStore.start();
    const controls =
      f.root.cakeChatCollectionStore.registry.load(SESSION_ASSISTANT_ID).props.controls;
    const request = async (name: string, args: Record<string, string>, id: string) => {
      act(() =>
        applyCakeChatControlUpdate(controls, {
          _tag: "Snapshot",
          requests: [
            {
              _tag: "ControlRequested",
              sessionId: SESSION_ASSISTANT_ID,
              controlRequestId: id,
              invocation: { name, arguments: args },
            },
          ],
        }),
      );
      await waitFor(() =>
        expect(respond).toHaveBeenCalledWith(
          id,
          expect.objectContaining({ ok: true }),
          expect.anything(),
        ),
      );
    };
    await request("vscode.enter", {}, "enter");
    expect(f.root.workspaceSession!.presentationMode).toBe("vscode");
    await request("vscode.open", { path: "src/main.ts" }, "open");
    expect(open).toHaveBeenCalledWith("/project", expect.anything());
    expect(reveal).toHaveBeenCalledWith(
      "/project",
      { kind: "working-directory", path: "src/main.ts" },
      expect.anything(),
    );
    expect(f.root.workspaceSession!.model.streaming).toBe(true);
    expect(prompt).not.toHaveBeenCalled();
    expect(abort).not.toHaveBeenCalled();
  });

  it("shows a failed quick admission and keeps the user's prompt for retry", async () => {
    const prompt = vi
      .fn<Client["sessionChats"]["prompt"]>()
      .mockRejectedValue(new Error("Lookup failed"));
    using f = renderSessionAssistant({ sessionChats: { prompt } });
    await f.user.click(screen.getByRole("button", { name: "Ask session assistant" }));
    const input = screen.getByRole("combobox", { name: "Ask session assistant" });
    await f.user.type(input, "Find the session");
    await f.user.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText("Lookup failed")).toBeDefined();
    expect(screen.getByRole("combobox", { name: "Ask session assistant" })).toHaveProperty(
      "value",
      "Find the session",
    );
  });

  it("waits for its own quick turn when a preceding full-chat turn settles", async () => {
    const earlier = TurnId.make("10000000-0000-4000-8000-000000000002");
    const prompt = vi
      .fn<Client["sessionChats"]["prompt"]>()
      .mockResolvedValueOnce(earlier)
      .mockResolvedValueOnce(turnId);
    using f = renderSessionAssistant({ sessionChats: { prompt } });
    await f.user.pointer({
      target: screen.getByRole("button", { name: "Ask session assistant" }),
      keys: "[MouseRight]",
    });
    await f.user.type(
      screen.getByRole("combobox", { name: "Message session assistant" }),
      "Long answer",
    );
    await f.user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(prompt).toHaveBeenCalledOnce());
    f.observe([], true);
    await f.user.keyboard("{Escape}");
    await f.user.click(screen.getByRole("button", { name: "Ask session assistant" }));
    await f.user.type(
      screen.getByRole("combobox", { name: "Ask session assistant" }),
      "Quick lookup",
    );
    await f.user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(prompt).toHaveBeenCalledTimes(2));
    f.settle(earlier, "Previous response", "Long answer");
    expect(screen.getByRole("status", { name: "Session assistant is thinking" })).toBeDefined();
    f.settle(turnId, "Quick response", "Quick lookup");
    expect(await screen.findByText("Quick response")).toBeDefined();
  });

  it("orients only on real entry, mode/scope changes, exit and re-entry, preserving history while open", async () => {
    const orientation = vi.fn<Client["cakeChats"]["assistantContext"]>(async () => undefined);
    using f = renderSessionAssistant({ cakeChats: { assistantContext: orientation } });
    await f.user.pointer({
      target: screen.getByRole("button", { name: "Ask session assistant" }),
      keys: "[MouseRight]",
    });
    await waitFor(() => expect(orientation).toHaveBeenCalledTimes(1));
    expect(orientation.mock.calls[0]?.[0].context).toMatchObject({
      sessionId: "parent-1",
      mode: "normal",
    });
    f.observe([
      { id: "old", kind: "text", role: "assistant", text: "I remember.", status: "complete" },
    ]);
    act(() => {
      f.root.workspaceSession!.presentationMode = "vscode";
    });
    await waitFor(() => expect(orientation).toHaveBeenCalledTimes(2));
    expect(orientation.mock.calls[1]?.[0].context?.mode).toBe("vscode");
    act(() => {
      f.root.sessionRegistry.load("parent-2", "/project");
      f.root.navigationStore.selectProjectSession("parent-2");
    });
    await waitFor(() => expect(orientation).toHaveBeenCalledTimes(3));
    expect(orientation.mock.calls[2]?.[0].context?.sessionId).toBe("parent-2");
    expect(await screen.findByText("I remember.")).toBeDefined();
    await f.user.keyboard("{Escape}");
    await waitFor(() => expect(orientation).toHaveBeenCalledTimes(4));
    expect(orientation.mock.calls[3]?.[0].context).toBeNull();
    await f.user.pointer({
      target: screen.getByRole("button", { name: "Ask session assistant" }),
      keys: "[MouseRight]",
    });
    await waitFor(() => expect(orientation).toHaveBeenCalledTimes(5));
    expect(orientation.mock.calls[4]?.[0].context?.sessionId).toBe("parent-2");
    expect(await screen.findByText("I remember.")).toBeDefined();
  });

  it.each([false, true])(
    "does not import invoking history, including staged sessions (%s)",
    async (staged) => {
      const prompt = vi.fn<Client["sessionChats"]["prompt"]>(async () => turnId);
      const open = vi.fn<Client["cakeChats"]["open"]>(async () => undefined);
      using f = renderSessionAssistant(
        { cakeChats: { open }, sessionChats: { prompt } },
        { staged },
      );
      await f.user.pointer({
        target: screen.getByRole("button", { name: "Ask session assistant" }),
        keys: "[MouseRight]",
      });
      await f.user.type(
        screen.getByRole("combobox", { name: "Message session assistant" }),
        "Quick one",
      );
      await f.user.click(screen.getByRole("button", { name: "Send" }));
      await waitFor(() => expect(prompt).toHaveBeenCalledOnce());
      expect(open.mock.calls[0]?.[0].sessionId).toBe(SESSION_ASSISTANT_ID);
      expect(JSON.stringify(open.mock.calls)).not.toContain("Draft the plan");
      expect(JSON.stringify(prompt.mock.calls)).not.toContain("Draft the plan");
      expect(prompt.mock.calls[0]?.[0]).toMatchObject({
        sessionId: SESSION_ASSISTANT_ID,
        text: "Quick one",
      });
    },
  );
});
