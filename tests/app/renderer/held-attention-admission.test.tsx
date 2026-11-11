/** @vitest-environment jsdom */
import { renderTranscriptContent } from "./render-transcript-content";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { applySnapshot } from "r-state-tree";
import { StoreProvider } from "r-state-tree/react";
import { Effect, Deferred } from "effect";
import { afterEach, expect, it } from "vitest";
import * as todos from "../../../src/domain/projects/projectTodos";
import * as attention from "../../../src/domain/projects/projectTodoAttention";
import * as messageReferences from "../../../src/domain/conversations/messageReferences";
import { projectChatSessionId } from "../../../src/domain/cake-chats/cakeChatLocations";
import { encodeCrossSessionMessage } from "../../../src/contracts/conversations/cross-session-message";
import { protectedResponseNotice } from "../../../src/contracts/conversations/reference-notification";
import { SessionFamilyStorage } from "../../../src/services/storage/SessionFamilyStorage";
import { CakeChatComposerHeader } from "../../../src/renderer/components/cake-chat-composer-header";
import { Chat } from "../../../src/renderer/components/chat";
import { applyConversationUpdate } from "../../../src/renderer/reducers/ConversationReducer";
import { appendMessageReferences } from "../../../src/contracts/conversations/message-reference-forwarding";
import { subagentLink } from "../../../src/contracts/subagents/subagent-reference";
import { passiveNoticeParts } from "../../../src/services/pi/runtime/internal-input-projection";
import {
  heldAttentionHarness,
  originalRef,
  originalText,
  originalPage,
  producer,
} from "../helpers/heldAttentionHarness";
import { snapshot } from "../helpers/piRuntimeFixture";
import { projectRecord } from "./fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "./renderer-store-fixture";

afterEach(cleanup);
const scope = "/project";
const chat = projectChatSessionId(scope);

it.each([
  { held: false, exactFirst: false },
  { held: true, exactFirst: false },
  { held: true, exactFirst: true },
])(
  "real attention row durably admits its owning-chat request (held=$held, sourceFirst=$exactFirst), retries, and renders the original once",
  async ({ held, exactFirst }) => {
    const backend = heldAttentionHarness();
    try {
      const item = await backend.runtime.runPromise(
        todos.create(scope, {
          title: "Investigate merge",
          description: "Findings ready",
          needsAttention: true,
          attentionReason: "Review the architecture findings and priorities",
          associations: [{ kind: "session", sessionId: producer, title: "Task session" }],
        }),
      );
      if (held)
        for (const exact of exactFirst ? [true, false] : [false, true])
          await backend.runtime.runPromise(
            attention.hold(
              {
                id: exact
                  ? "bc07709c-cd12-48ae-9738-799652dc25a0"
                  : "59f835d4-eab3-4a91-bd37-0576bf02b0ec",
                recipientSessionId: chat,
                responseKey: "exact-request-turn",
                text: encodeCrossSessionMessage(
                  exact
                    ? appendMessageReferences(protectedResponseNotice, [originalRef])
                    : protectedResponseNotice,
                  {
                    version: 1,
                    messageId: exact
                      ? "bc07709c-cd12-48ae-9738-799652dc25a0"
                      : "59f835d4-eab3-4a91-bd37-0576bf02b0ec",
                    threadId: exact
                      ? "e055e7ea-7b85-4334-9e69-8273fbc27ceb"
                      : "b521f0b4-270c-4908-9a06-d6bbfb22f59e",
                    sequence: 1,
                    expectsResponse: false,
                    resultDelivery: "ignore",
                    generatedNotice: !exact,
                    ...(exact ? { sourceMessageRef: originalRef } : null),
                    sender: { sessionId: producer, title: "Task session", kind: "project-session" },
                  },
                ),
              },
              { sessionId: producer },
            ),
          );
      const initial = await backend.runtime.runPromise(todos.list(scope));
      const projection = () => ({ ...projectRecord({ path: scope }), todos: initial });
      using fixture = createRendererStoreFixture({
        projects: [projection()],
        client: {
          projectTodos: {
            activateAttention: async (input) => {
              const result = await backend.runtime.runPromise(
                attention.activate(input.scope, input.id, input.expectedRevision),
              );
              applySnapshot(fixture.models.projects, {
                projects: [{ ...projection(), todos: result.todos }],
              });
              expect(result.resultPartIds).toEqual(
                passiveNoticeParts(backend.submissions.at(-1)?.internal).map((part) => part.id),
              );
              return result;
            },
          },
          sessionChats: {
            inspect: async (input) =>
              backend.runtime.runPromise(
                messageReferences.read({
                  ref: input.ref ?? originalRef,
                  offset: input.offset,
                  maxChars: input.maxChars,
                }),
              ),
          },
        },
      });
      applySnapshot(fixture.models.cakeChatCatalog, {
        loaded: true,
        sessions: [{ sessionId: chat, title: "Project Chat", projectPath: scope }],
      });
      const session = fixture.root.cakeChatCollectionStore.registry.load(chat);
      const view = render(
        <StoreProvider store={fixture.root}>
          <CakeChatComposerHeader session={session} />
        </StoreProvider>,
      );
      const open = () => screen.getByRole("button", { name: "Open attention: Investigate merge" });
      backend.state.reject = !held;
      backend.state.sourceAvailable = !held;
      await act(async () => fireEvent.click(open()));
      expect(await screen.findByRole("alert")).toBeTruthy();
      expect(open()).not.toHaveProperty("disabled", true);
      expect(backend.submissions).toHaveLength(0);
      expect((await backend.runtime.runPromise(todos.read(scope, item.id))).needsAttention).toBe(
        true,
      );
      backend.state.reject = false;
      backend.state.sourceAvailable = true;
      backend.state.streaming = true;
      const gate = Deferred.makeUnsafe<void>();
      backend.state.beforeSubmit = Deferred.await(gate);
      await act(async () => {
        fireEvent.click(open());
        fireEvent.click(open());
      });
      expect(open()).toHaveProperty("disabled", true);
      expect(
        screen.getByRole("region", { name: "Needs attention" }).getAttribute("aria-busy"),
      ).toBe("true");
      expect(screen.getByRole("region", { name: "Needs attention" })).toBeTruthy();
      await act(async () => {
        await Effect.runPromise(Deferred.succeed(gate, undefined));
      });
      await waitFor(() =>
        expect(screen.queryByRole("region", { name: "Needs attention" })).toBeNull(),
      );
      expect(backend.submissions).toHaveLength(1);
      expect(
        session.conversationSessionStore.chatStore.transcriptInteraction.resultReveal?.partIds ??
          [],
      ).toEqual(passiveNoticeParts(backend.submissions[0]?.internal).map((part) => part.id));
      expect(backend.submissions[0]?.delivery).toBe("follow-up");
      expect(backend.submissions[0]?.text).toContain(item.title);
      expect(backend.submissions[0]?.text).toContain("not approval to merge");
      expect(backend.acquired).toContain(chat);
      const persisted = await backend.runtime.runPromise(
        Effect.gen(function* () {
          return yield* (yield* SessionFamilyStorage).state();
        }),
      );
      expect(persisted.handledReports ?? []).toHaveLength(0);
      expect(persisted.deferredReferences?.[0]?.attentionTodoId).toBeUndefined();
      expect((await backend.runtime.runPromise(todos.read(scope, item.id))).state).toBe("open");
      if (held) {
        const submission = backend.submissions[0];
        const parts = passiveNoticeParts(submission?.internal);
        expect(parts).toHaveLength(1);
        view.unmount();
        // Reload the authoritative admitted presentation, then use the actual source card path.
        applyConversationUpdate(session.model, {
          _tag: "Snapshot",
          revision: 1,
          snapshot: { ...snapshot, sessionId: chat, parts },
        });
        session.conversationSessionStore.chatStore.transcriptInteraction.setTranscriptScrollPosition(
          { kind: "top" },
        );
        renderTranscriptContent(
          <Chat
            store={session.conversationSessionStore.chatStore}
            compact
            composerFocusEnabled={false}
          />,
        );
        backend.state.sourceAvailable = false;
        await act(async () =>
          fireEvent.click(screen.getByRole("button", { name: "Task session" })),
        );
        expect((await screen.findByRole("alert")).textContent).toContain(
          "Source temporarily unavailable",
        );
        backend.state.sourceAvailable = true;
        await act(async () =>
          fireEvent.click(screen.getByRole("button", { name: "Retry source" })),
        );
        expect(await screen.findByText(originalText)).toBeTruthy();
        expect(screen.getAllByText(originalText)).toHaveLength(1);
        expect(
          (
            await backend.runtime.runPromise(
              Effect.gen(function* () {
                return yield* (yield* SessionFamilyStorage).state();
              }),
            )
          ).deferredReferences,
        ).toHaveLength(1);
      }
    } finally {
      await backend.runtime.dispose();
    }
  },
);

it("a durable receipt survives interruption/retry; later attention is not cleared by the earlier admission", async () => {
  const backend = heldAttentionHarness();
  try {
    const item = await backend.runtime.runPromise(
      todos.create(scope, {
        title: "Review",
        description: "Findings",
        needsAttention: true,
        attentionReason: "First generation",
      }),
    );
    // A different writer raises new attention while the first durable handoff completes.
    const gate = Deferred.makeUnsafe<void>();
    const entered = Deferred.makeUnsafe<void>();
    backend.state.beforeSubmit = Deferred.succeed(entered, undefined).pipe(
      Effect.andThen(Deferred.await(gate)),
    );
    const activating = backend.runtime.runPromise(
      attention.activate(scope, item.id, item.revision),
    );
    await Effect.runPromise(Deferred.await(entered));
    await backend.runtime.runPromise(
      todos.update(scope, {
        id: item.id,
        expectedRevision: item.revision,
        needsAttention: true,
        attentionReason: "Later generation",
      }),
    );
    await Effect.runPromise(Deferred.succeed(gate, undefined));
    await activating;
    expect((await backend.runtime.runPromise(todos.read(scope, item.id))).needsAttention).toBe(
      true,
    );
    expect(backend.submissions).toHaveLength(1);
    backend.state.beforeSubmit = undefined;
    const current = await backend.runtime.runPromise(todos.read(scope, item.id));
    await backend.runtime.runPromise(attention.activate(scope, current.id, current.revision));
    expect(backend.submissions).toHaveLength(2);
    expect(backend.submissions[1]?.turnId).not.toBe(backend.submissions[0]?.turnId);
  } finally {
    await backend.runtime.dispose();
  }
});

it("the actual contextual worker card reads its exact public ref, not its parent or latest response", async () => {
  const ref = subagentLink(chat, "0a1d0405-5e34-4b74-8b3a-12d5df4b7620", "52a9cef5");
  const reads: string[] = [];
  using fixture = createRendererStoreFixture({
    projects: [projectRecord({ path: scope })],
    client: {
      sessionChats: {
        inspect: async (input) => {
          expect(input.ref).toBe(ref);
          reads.push(input.ref ?? "");
          return {
            ...originalPage,
            message: {
              ...originalPage.message,
              ref,
              link: ref,
              sessionId: chat,
              entryId: "52a9cef5",
            },
          };
        },
      },
    },
  });
  applySnapshot(fixture.models.cakeChatCatalog, {
    loaded: true,
    sessions: [{ sessionId: chat, title: "Project Chat", projectPath: scope }],
  });
  const session = fixture.root.cakeChatCollectionStore.registry.load(chat);
  applyConversationUpdate(session.model, {
    _tag: "Snapshot",
    revision: 1,
    snapshot: {
      ...snapshot,
      sessionId: chat,
      parts: [
        {
          id: "worker-report",
          kind: "text",
          role: "user",
          status: "complete",
          text: "",
          agentSource: { title: "Research merge", href: ref },
        },
      ],
    },
  });
  session.conversationSessionStore.chatStore.transcriptInteraction.setTranscriptScrollPosition({
    kind: "top",
  });
  renderTranscriptContent(
    <Chat
      store={session.conversationSessionStore.chatStore}
      compact
      composerFocusEnabled={false}
    />,
  );
  expect(reads).toEqual([]);
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Research merge" })));
  expect(await screen.findByText(originalText)).toBeTruthy();
  expect(reads).toEqual([ref]);
});
