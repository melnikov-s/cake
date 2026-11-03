/** @vitest-environment jsdom */
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TurnId } from "../../../src/contracts/conversations/conversation-data";
import {
  CAKE_CHAT_SESSION_ID,
  SESSION_ASSISTANT_ID,
} from "../../../src/contracts/cake-chats/cake-chat-identity";
import { applySnapshot } from "r-state-tree";
import { projectRecord, sessionSummary } from "./fixtures/catalog-fixtures";
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

  it("updates invoking project, worktree and title facts, then clears them for projectless and absent contexts", async () => {
    const orientation = vi.fn<Client["cakeChats"]["assistantContext"]>(async () => undefined);
    const open = vi.fn<Client["cakeChats"]["open"]>(async () => undefined);
    const prompt = vi.fn<Client["sessionChats"]["prompt"]>();
    using f = renderSessionAssistant({
      cakeChats: { assistantContext: orientation, open },
      sessionChats: { prompt },
    });
    const shared = f.root.cakeChatCollectionStore.registry.load(SESSION_ASSISTANT_ID);
    await f.user.pointer({
      target: screen.getByRole("button", { name: "Ask session assistant" }),
      keys: "[MouseRight]",
    });
    await waitFor(() => expect(orientation).toHaveBeenCalledTimes(1));
    expect(orientation.mock.calls[0]?.[0].context).toEqual({
      sessionId: "parent-1",
      title: "parent-1",
      kind: "project-session",
      mode: "normal",
      project: { path: "/project", name: "Project" },
      workingDirectory: "/project",
      worktree: null,
    });
    f.observe([
      { id: "shared", kind: "text", role: "assistant", text: "Shared history", status: "complete" },
    ]);
    act(() => {
      applySnapshot(f.models.worktrees, {
        worktrees: [
          {
            projectPath: "/project",
            worktreePath: "/checkout/app",
            checkoutPath: "/checkout",
            branch: "agent/topic",
            baseBranch: "main",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      });
      applySnapshot(f.models.sessionCatalog, {
        sessions: [
          sessionSummary({
            sessionId: "parent-1",
            title: "Renamed session",
            projectPath: "/project",
            workingDirectory: "/checkout/app",
          }),
        ],
      });
    });
    await waitFor(() => expect(orientation).toHaveBeenCalledTimes(2));
    expect(orientation.mock.calls[1]?.[0].context).toMatchObject({
      title: "Renamed session",
      project: { path: "/project", name: "Project" },
      workingDirectory: "/checkout/app",
      worktree: { path: "/checkout/app", checkoutPath: "/checkout", branch: "agent/topic" },
    });
    const projectChat = `project-chat:${"b".repeat(64)}`;
    act(() => {
      applySnapshot(f.models.projects, {
        projects: [
          projectRecord({ path: "/project", name: "Project" }),
          projectRecord({ path: "/other", name: "Other Project" }),
        ],
      });
      applySnapshot(f.models.cakeChatCatalog, {
        loaded: true,
        sessions: [
          { sessionId: projectChat, title: "Other Project Chat", projectPath: "/other" },
          { sessionId: CAKE_CHAT_SESSION_ID, title: "Cake Chat" },
        ],
      });
      f.root.cakeChatCollectionStore.registry.load(projectChat);
      f.root.navigationStore.selectCakeChat(projectChat);
    });
    await waitFor(() => expect(orientation).toHaveBeenCalledTimes(3));
    expect(orientation.mock.calls[2]?.[0].context).toEqual({
      sessionId: projectChat,
      title: "Other Project Chat",
      kind: "project-chat",
      mode: "normal",
      project: { path: "/other", name: "Other Project" },
      workingDirectory: "/other",
      worktree: null,
    });
    act(() => {
      f.root.cakeChatCollectionStore.registry.load(CAKE_CHAT_SESSION_ID);
      f.root.navigationStore.selectCakeChat(CAKE_CHAT_SESSION_ID);
    });
    await waitFor(() => expect(orientation).toHaveBeenCalledTimes(4));
    expect(orientation.mock.calls[3]?.[0].context).toEqual({
      sessionId: CAKE_CHAT_SESSION_ID,
      title: "Cake Chat",
      kind: "cake-chat",
      mode: "normal",
      project: null,
      workingDirectory: null,
      worktree: null,
    });
    act(() => f.root.navigationStore.showEmptyWorkbench());
    await waitFor(() => expect(orientation).toHaveBeenCalledTimes(5));
    expect(orientation.mock.calls[4]?.[0].context).toBeNull();
    expect(f.root.cakeChatCollectionStore.registry.load(SESSION_ASSISTANT_ID)).toBe(shared);
    act(() => f.root.navigationStore.selectProjectSession("parent-1"));
    await f.user.pointer({
      target: screen.getByRole("button", { name: "Ask session assistant" }),
      keys: "[MouseRight]",
    });
    await waitFor(() => expect(orientation).toHaveBeenCalledTimes(6));
    expect(await screen.findByText("Shared history")).toBeDefined();
    expect(
      open.mock.calls.filter(([target]) => target.sessionId === SESSION_ASSISTANT_ID),
    ).toHaveLength(6);
    expect(prompt).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "does not import invoking history, including staged sessions (%s)",
    async (staged) => {
      const prompt = vi.fn<Client["sessionChats"]["prompt"]>(async () => turnId);
      const open = vi.fn<Client["cakeChats"]["open"]>(async () => undefined);
      const orientation = vi.fn<Client["cakeChats"]["assistantContext"]>(async () => undefined);
      using f = renderSessionAssistant(
        { cakeChats: { open, assistantContext: orientation }, sessionChats: { prompt } },
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
      expect(orientation.mock.calls[0]?.[0].context).toMatchObject({
        sessionId: "parent-1",
        kind: "project-session",
        project: { path: "/project", name: "Project" },
        workingDirectory: "/project",
        worktree: null,
      });
      expect(JSON.stringify(open.mock.calls)).not.toContain("Draft the plan");
      expect(JSON.stringify(prompt.mock.calls)).not.toContain("Draft the plan");
      expect(prompt.mock.calls[0]?.[0]).toMatchObject({
        sessionId: SESSION_ASSISTANT_ID,
        text: "Quick one",
      });
    },
  );
});
