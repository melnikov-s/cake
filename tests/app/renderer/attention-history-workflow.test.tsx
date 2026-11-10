/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { applySnapshot } from "r-state-tree";
import { StoreProvider } from "r-state-tree/react";
import { afterEach, expect, it, vi } from "vitest";
import { CakeChatComposerHeader } from "../../../src/renderer/components/cake-chat-composer-header";
import { ChatTranscript } from "../../../src/renderer/components/chat-transcript";
import type { UiPart } from "../../../src/contracts/conversations/session-contract";
import { emptyProjectTodos, type ProjectTodo } from "../../../src/contracts/projects/project-todos";
import { applyConversationUpdate } from "../../../src/renderer/reducers/ConversationReducer";
import { projectRecord } from "./fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "./renderer-store-fixture";
import { queuePart } from "./prompt-queue-workflow-fixture";
import { snapshot } from "../helpers/piRuntimeFixture";

afterEach(cleanup);
const chat = `project-chat:${"a".repeat(64)}`;
const item: ProjectTodo = {
  id: "00000000-0000-4000-8000-000000000011",
  title: "Review",
  description: "",
  status: "",
  state: "open",
  revision: 0,
  associations: [],
  needsAttention: true,
  attentionReason: "Review findings",
};

it.each([false, true])(
  "queued attention never pages, including receipt-before-projection=%s, consumption and cancellation",
  async (receiptFirst) => {
    const history = vi.fn(async ({ cursor }: { cursor: string }) => ({
      parts: [] as UiPart[],
      cursor: Number(cursor) < 4 ? String(Number(cursor) + 1) : undefined,
    }));
    using fixture = createRendererStoreFixture({
      projects: [
        {
          ...projectRecord({ path: "/project" }),
          todos: { ...emptyProjectTodos(), items: [item] },
        },
      ],
      client: {
        projectTodos: {
          activateAttention: async () => {
            if (!receiptFirst) publish([existing, automatic]);
            return {
              todos: emptyProjectTodos(),
              resultPartIds: ["future-result"],
              responseTurnId: "10000000-0000-4000-8000-000000000002",
              resultSource: "incoming",
            };
          },
        },
        sessionChats: {
          history,
          removeQueuedMessage: async () => ({ steering: [], followUp: [] }),
        },
      },
    });
    applySnapshot(fixture.models.cakeChatCatalog, {
      loaded: true,
      sessions: [{ sessionId: chat, title: "Project Chat", projectPath: "/project" }],
    });
    const session = fixture.root.cakeChatCollectionStore.registry.load(chat);
    const store = session.conversationSessionStore.chatStore;
    let revision = 0;
    const existing = queuePart(1, "Already queued", {
      turnId: "10000000-0000-4000-8000-000000000001",
    });
    const queued = queuePart(2, "Attention", { turnId: "10000000-0000-4000-8000-000000000002" });
    const automatic = {
      ...queued,
      queuedInput: { ...queued.queuedInput!, internal: "UpdateBatch" as const },
    };
    function publish(parts: UiPart[]) {
      applyConversationUpdate(session.model, {
        _tag: "Snapshot",
        revision: ++revision,
        snapshot: { ...snapshot, sessionId: chat, historyCursor: "1", streaming: true, parts },
      });
    }
    publish([existing]);
    const content = (
      <StoreProvider store={fixture.root}>
        <CakeChatComposerHeader session={session} />
        <ChatTranscript store={store} />
      </StoreProvider>
    );
    const view = render(content);
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Open attention: Review" })),
    );
    expect(history).not.toHaveBeenCalled();
    expect(store.transcriptInteraction.resultReveal?.source).toBe("incoming");
    await act(async () => publish([existing, automatic]));
    expect(history).not.toHaveBeenCalled();
    // Queue disappearance can mean consumption, not cancellation: keep waiting
    // for the exact result, without changing it into an historical search.
    await act(async () => publish([existing]));
    expect(history).not.toHaveBeenCalled();
    expect(store.transcriptInteraction.resultReveal?.source).toBe("incoming");
    await act(async () =>
      publish([
        existing,
        {
          kind: "text",
          id: "future-result",
          role: "assistant",
          text: "Exact result",
          status: "complete",
        },
      ]),
    );
    expect(screen.getByText("Exact result")).toBeDefined();
    expect(store.transcriptInteraction.resultReveal?.source).toBe("history");
    expect(history).not.toHaveBeenCalled();
    await act(async () => {
      publish([existing, automatic]);
      const revision = store.transcriptInteraction.beginResultReveal();
      store.transcriptInteraction.completeResultReveal(
        revision,
        ["never-produced"],
        "10000000-0000-4000-8000-000000000002",
      );
      store.removeQueuedPrompt(automatic.id);
    });
    expect(store.transcriptInteraction.resultReveal).toBeUndefined();
    // Exiting before a receipt also invalidates the old revision.
    const pending = store.transcriptInteraction.beginResultReveal();
    view.unmount();
    store.transcriptInteraction.completeResultReveal(pending, ["late-result"], "late-turn");
    expect(store.transcriptInteraction.resultReveal).toBeUndefined();
    render(content);
    expect(history).not.toHaveBeenCalled();
  },
);
