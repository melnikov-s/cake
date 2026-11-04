/** @vitest-environment jsdom */
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Effect, Queue, Stream } from "effect";
import { applySnapshot } from "r-state-tree";
import { StoreProvider } from "r-state-tree/react";
import { afterEach, expect, it, vi } from "vitest";
import type { applicationEventSchema } from "../../../src/contracts/application/cake-rpc-contract";
import { CAKE_CHAT_SESSION_ID } from "../../../src/contracts/cake-chats/cake-chat-identity";
import type { ConversationSnapshot } from "../../../src/contracts/conversations/conversation-data";
import {
  receiveCakeChatOverlayContext,
  startCakeChatOverlay,
} from "../../../src/renderer/bootstrap/start-cake-chat-overlay";
import { CakeChatSurface } from "../../../src/renderer/components/cake-chat-surface";
import type { Client } from "../../../src/renderer/client/Client";
import { observeApplicationEvents } from "../../../src/renderer/observers/application-events";
import { applyConversationUpdate } from "../../../src/renderer/reducers/ConversationReducer";
import { projectRecord, sessionSummary } from "./fixtures/catalog-fixtures";
import { observerClient, observerRuntime } from "./observers/observer-test-runtime";
import { createRendererStoreFixture } from "./renderer-store-fixture";

const projectChatId = `project-chat:${"a".repeat(64)}`;
afterEach(cleanup);

function conversation(sessionId: string): ConversationSnapshot {
  return {
    sessionId,
    sessionFile: `/sessions/${sessionId}.jsonl`,
    parts: [],
    models: [],
    thinkingLevel: "off",
    availableThinkingLevels: ["off"],
    streaming: false,
    diagnostics: [],
    commands: [],
    compatibility: { resources: [], diagnostics: [] },
    extensionUi: { statuses: [] },
    tree: [],
  };
}

function fixture() {
  const showCakeChatOverlay = vi.fn<Client["electron"]["showCakeChatOverlay"]>(async () => {});
  const view = createRendererStoreFixture({
    projects: [projectRecord({ path: "/project", name: "Project" })],
    sessions: [sessionSummary({ sessionId: "alpha", title: "Session A", projectPath: "/project" })],
    client: {
      electron: { showCakeChatOverlay },
      cakeChats: { open: async () => {} },
    },
  });
  applySnapshot(view.models.cakeChatCatalog, {
    loaded: true,
    sessions: [
      { sessionId: CAKE_CHAT_SESSION_ID, title: "Cake Chat", resolved: false },
      { sessionId: projectChatId, title: "Project Chat", projectPath: "/project", resolved: false },
    ],
  });
  for (const sessionId of [CAKE_CHAT_SESSION_ID, projectChatId]) {
    view.root.cakeChatCollectionStore.registry.load(sessionId);
    view.root.cakeChatCollectionStore.pendingSessions.markMaterialized(sessionId);
    applyConversationUpdate(view.models.cakeChatConversation(sessionId), {
      _tag: "Snapshot",
      revision: 1,
      snapshot: conversation(sessionId),
    });
  }
  view.root.sessionRegistry.load("alpha", "/project");
  applyConversationUpdate(view.models.projectConversation("alpha", "/project"), {
    _tag: "Snapshot",
    revision: 1,
    snapshot: conversation("alpha"),
  });
  const events = Effect.runSync(Queue.unbounded<typeof applicationEventSchema.Type>());
  const stop = observeApplicationEvents(
    observerRuntime(
      observerClient({
        events: { application: () => Stream.fromQueue(events) },
      }),
    ),
    view.root,
  );
  return {
    ...view,
    showCakeChatOverlay,
    invoke: () => Queue.offerUnsafe(events, { type: "cake-chat-overlay-requested" }),
    [Symbol.dispose]: () => {
      stop();
      view[Symbol.dispose]();
    },
  };
}

it("resolves native invocation from the visible Project Session, Project Chat, and no-context surfaces", async () => {
  using view = fixture();
  view.root.navigationStore.selectProjectSession("alpha");
  view.root.sessionLayoutStore.ensureSession("alpha");
  const draft =
    view.root.sessionRegistry.findSession("alpha")!.conversationSessionStore.composerStore
      .draftStore;
  draft.setText("Unfinished work");
  view.invoke();
  await waitFor(() => expect(view.showCakeChatOverlay).toHaveBeenLastCalledWith(projectChatId));
  expect(draft.text).toBe("Unfinished work");
  expect(view.root.appShellStore.selection).toMatchObject({
    kind: "project-session",
    sessionId: "alpha",
  });

  await act(() => view.root.navigationStore.openCakeChat(projectChatId));
  view.invoke();
  await waitFor(() =>
    expect(view.showCakeChatOverlay).toHaveBeenLastCalledWith(CAKE_CHAT_SESSION_ID),
  );
  view.root.appShellStore.showSettings();
  view.invoke();
  await waitFor(() => expect(view.showCakeChatOverlay).toHaveBeenCalledTimes(3));
  expect(view.showCakeChatOverlay).toHaveBeenLastCalledWith(CAKE_CHAT_SESSION_ID);
});

it("uses the capture picker to switch quick-chat drafts without sending or discarding either draft", async () => {
  using view = fixture();
  await act(() => startCakeChatOverlay(view.root));
  const globalDraft =
    view.root.cakeChatCollectionStore.registry.find(CAKE_CHAT_SESSION_ID)!.conversationSessionStore
      .composerStore.draftStore;
  const projectDraft =
    view.root.cakeChatCollectionStore.registry.find(projectChatId)!.conversationSessionStore
      .composerStore.draftStore;
  globalDraft.setText("Global idea");
  projectDraft.setText("Project idea");
  const rendered = render(
    <StoreProvider store={view.root}>
      <CakeChatSurface overlay={{ onClose() {}, onCaptureScreenshot() {}, capturing: false }} />
    </StoreProvider>,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Chat destination" }));
  await user.click(screen.getByRole("button", { name: "Open Project Chat for Project" }));
  await waitFor(() =>
    expect(screen.getByRole("combobox", { name: "Message Project Chat" })).toHaveProperty(
      "value",
      "Project idea",
    ),
  );
  expect(globalDraft.text).toBe("Global idea");
  expect(projectDraft.text).toBe("Project idea");
  await act(() => receiveCakeChatOverlayContext(view.root, {}));
  expect(view.root.appShellStore.selection).toMatchObject({ sessionId: projectChatId });
  await user.click(screen.getByRole("button", { name: "Chat destination" }));
  await user.click(screen.getByRole("button", { name: "Cake Chat" }));
  await waitFor(() =>
    expect(screen.getByRole("combobox", { name: "Message Cake Chat" })).toHaveProperty(
      "value",
      "Global idea",
    ),
  );
  expect(projectDraft.text).toBe("Project idea");
  rendered.unmount();
});

it("makes the quick-chat title the only session switcher and lists Cake Chat once", async () => {
  using view = fixture();
  await act(() => startCakeChatOverlay(view.root));
  const rendered = render(
    <StoreProvider store={view.root}>
      <CakeChatSurface overlay={{ onClose() {}, onCaptureScreenshot() {}, capturing: false }} />
    </StoreProvider>,
  );
  const header = document.querySelector<HTMLElement>('[data-slot="workspace-header"]')!;
  const actions = header.querySelector<HTMLElement>('[data-slot="workspace-actions"]')!;
  const trigger = within(header).getByRole("button", { name: "Chat destination" });
  expect(within(header).getAllByRole("button", { name: "Chat destination" })).toHaveLength(1);
  expect(actions.contains(trigger)).toBe(false);
  expect(trigger.textContent).toBe("Cake Chat");
  expect(within(actions).getByRole("button", { name: "Take screenshot" })).toBeTruthy();

  const user = userEvent.setup();
  await user.click(trigger);
  const menu = within(screen.getByRole("dialog", { name: "Chat destination" }));
  const cakeChat = menu.getByRole("button", { name: "Cake Chat" });
  expect(menu.getAllByText("Cake Chat")).toHaveLength(1);
  expect(cakeChat.getAttribute("aria-current")).toBe("page");

  await user.click(menu.getByRole("button", { name: "Open Project Chat for Project" }));
  await waitFor(() =>
    expect(within(header).getByRole("button", { name: "Chat destination" }).textContent).toBe(
      "Project Chat",
    ),
  );
  rendered.unmount();
});
