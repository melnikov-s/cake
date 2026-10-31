/** @vitest-environment jsdom */
import { act, cleanup, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import {
  CAKE_CHAT_SESSION_ID,
  SESSION_ASSISTANT_ID,
} from "../../../src/contracts/cake-chats/cake-chat-identity";
import { projectChatSessionId } from "../../../src/domain/cake-chats/cakeChatLocations";
import type { Client } from "../../../src/renderer/client/Client";
import { renderSessionAssistant } from "./session-assistant-workflow-fixture";

afterEach(cleanup);
// Entry-point availability/focus is covered in project-chat.smoke; this checks cross-scope metadata.
it("shares identity across projectless/global and Project Chat transitions while open", async () => {
  const context = vi.fn<Client["cakeChats"]["assistantContext"]>(async () => undefined);
  using f = renderSessionAssistant({ cakeChats: { assistantContext: context } });
  const projectChat = projectChatSessionId("/project");
  act(() => {
    f.root.cakeChatCollectionStore.registry.load(projectChat);
    f.root.cakeChatCollectionStore.registry.load(CAKE_CHAT_SESSION_ID);
    f.root.navigationStore.selectCakeChat(projectChat);
  });
  await f.user.click(screen.getByRole("button", { name: "Ask session assistant" }));
  expect(screen.getByRole("dialog", { name: "Quick session assistant" })).toBeDefined();
  await waitFor(() => expect(context).toHaveBeenCalledTimes(1));
  expect(context.mock.calls[0]?.[0].context?.sessionId).toBe(projectChat);
  await f.user.pointer({
    target: screen.getByRole("button", { name: "Ask session assistant" }),
    keys: "[MouseRight]",
  });
  expect(screen.getByRole("dialog", { name: "Session assistant chat" })).toBeDefined();
  expect(context).toHaveBeenCalledTimes(1);
  act(() => f.root.navigationStore.selectCakeChat(CAKE_CHAT_SESSION_ID));
  await waitFor(() => expect(context).toHaveBeenCalledTimes(2));
  expect(context.mock.calls[1]?.[0].context?.sessionId).toBe(CAKE_CHAT_SESSION_ID);
  expect(screen.getByRole("dialog", { name: "Session assistant chat" })).toBeDefined();
  expect(f.root.sessionAssistantStore.session.sessionId).toBe(SESSION_ASSISTANT_ID);
  const tools = f.root.sessionAssistantStore.session.props
    .target()
    .tools.map((tool) => tool.command);
  expect(tools).toEqual(
    expect.arrayContaining(["vscode.enter", "vscode.open", "sessions.open", "sessions.list"]),
  );
  await f.user.keyboard("{Escape}");
  await waitFor(() => expect(context).toHaveBeenCalledTimes(3));
  expect(context.mock.calls[2]?.[0].context).toBeNull();
});
