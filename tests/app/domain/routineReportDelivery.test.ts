import { expect, it } from "vitest";
import { Effect } from "effect";
import { CAKE_CHAT_SESSION_ID } from "../../../src/contracts/cake-chats/cake-chat-identity";
import { CAKE_CHAT_TODO_SCOPE } from "../../../src/contracts/projects/project-todos";
import * as todos from "../../../src/domain/projects/projectTodos";
import * as sessionChats from "../../../src/domain/conversations/sessionChats";
import * as reports from "../../../src/domain/conversations/pendingReports";
import { projectChatSessionId } from "../../../src/domain/cake-chats/cakeChatLocations";
import { SessionFamilyStorage } from "../../../src/services/storage/SessionFamilyStorage";
import { heldAttentionHarness, originalRef, producer } from "../helpers/heldAttentionHarness";

it.each(
  [CAKE_CHAT_TODO_SCOPE, "/project"].flatMap((scope) =>
    [false, true].map((actionable) => ({ scope, actionable })),
  ),
)(
  "reference report admission preserves explicit attention only ($scope, actionable=$actionable)",
  async ({ scope, actionable }) => {
    const f = heldAttentionHarness();
    try {
      const recipient =
        scope === CAKE_CHAT_TODO_SCOPE ? CAKE_CHAT_SESSION_ID : projectChatSessionId(scope);
      const item = await f.runtime.runPromise(
        todos.create(scope, {
          title: "Implementation",
          description: "Working",
          needsAttention: actionable,
          ...(actionable ? { attentionReason: "Choose the release target" } : null),
          associations: [{ kind: "session", sessionId: producer, title: "Implementation" }],
        }),
      );
      const messageId = crypto.randomUUID();
      const incoming = {
        sessionId: recipient,
        text: originalRef,
        attachments: [],
        renderUserMessageAsMarkdown: false,
        crossSession: {
          version: 1 as const,
          messageId,
          threadId: crypto.randomUUID(),
          sequence: 1,
          expectsResponse: false,
          resultDelivery: "ignore" as const,
          sourceMessageRef: originalRef,
          sender: {
            sessionId: producer,
            kind: "project-session" as const,
            title: "Implementation",
          },
        },
      };
      // Use production admission, including its notice serialization and retry identity.
      await f.runtime.runPromise(sessionChats.deliver(incoming, "prompt").pipe(Effect.scoped));
      await f.runtime.runPromise(sessionChats.deliver(incoming, "prompt").pipe(Effect.scoped));
      expect(f.submissions).toHaveLength(0);
      expect(await f.runtime.runPromise(todos.read(scope, item.id))).toEqual(item);
      const pending = await f.runtime.runPromise(
        Effect.gen(function* () {
          return (yield* (yield* SessionFamilyStorage).state()).deferredReferences ?? [];
        }),
      );
      expect(pending).toHaveLength(1);
      expect(pending[0]?.resultMessageRef).toBe(originalRef);
      expect(pending[0]?.attentionTodoId).toBe(actionable ? item.id : undefined);
      expect((await f.runtime.runPromise(reports.list(recipient, {}))).total).toBe(
        actionable ? 0 : 1,
      );
      await f.runtime.runPromise(
        sessionChats
          .deliver(
            {
              sessionId: recipient,
              text: "My next question",
              attachments: [],
              renderUserMessageAsMarkdown: false,
            },
            "prompt",
          )
          .pipe(Effect.scoped),
      );
      expect(f.submissions).toHaveLength(1);
      expect(f.submissions[0]?.text.includes(originalRef)).toBe(!actionable);
      expect(await f.runtime.runPromise(todos.read(scope, item.id))).toEqual(item);
      if (!actionable) {
        const retained = await f.runtime.runPromise(reports.read(recipient, { id: messageId }));
        expect(retained.ref).toBe(originalRef);
        // Admission is not acknowledgment: the obligation remains until visible communication.
        expect((await f.runtime.runPromise(reports.list(recipient, {}))).items[0]?.admissions).toBe(
          1,
        );
        await expect(
          f.runtime.runPromise(
            reports
              .acknowledge(recipient, {
                ids: [messageId],
                disposition: "communicated",
                communicatedText: "Not yet communicated",
              })
              .pipe(Effect.scoped),
          ),
        ).rejects.toThrow();
        expect((await f.runtime.runPromise(reports.list(recipient, {}))).total).toBe(1);
      }
    } finally {
      await f.runtime.dispose();
    }
  },
);
