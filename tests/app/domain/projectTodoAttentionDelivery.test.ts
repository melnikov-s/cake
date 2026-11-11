import { unusedMessageLookupLayer } from "../helpers/heldAttentionHarness";
import { it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect } from "vitest";
import { CAKE_CHAT_SESSION_ID } from "../../../src/contracts/cake-chats/cake-chat-identity";
import { CAKE_CHAT_TODO_SCOPE } from "../../../src/contracts/projects/project-todos";
import { encodeCrossSessionMessage } from "../../../src/contracts/conversations/cross-session-message";
import * as attention from "../../../src/domain/projects/projectTodoAttention";
import * as todos from "../../../src/domain/projects/projectTodos";
import * as reports from "../../../src/domain/conversations/pendingReports";
import { projectChatSessionId } from "../../../src/domain/cake-chats/cakeChatLocations";
import { CakeSessionRuntimes, PiSessionError } from "../../../src/services/pi/CakeSessionRuntimes";
import { TaskInputStorage } from "../../../src/services/storage/TaskInputStorage";
import { SessionFamilyStorage } from "../../../src/services/storage/SessionFamilyStorage";
import { projectTodoLayer } from "../helpers/projectTodoHarness";
import { familyStorageHarness } from "../helpers/familyStorageHarness";

const report = (recipientSessionId: string, id = crypto.randomUUID()) => ({
  id,
  recipientSessionId,
  text: encodeCrossSessionMessage("The final report.", {
    version: 1,
    messageId: id,
    threadId: id,
    sequence: 1,
    expectsResponse: false,
    sender: { sessionId: "worker", kind: "project-session", title: "Worker" },
  }),
});
const layer = () =>
  Layer.mergeAll(
    projectTodoLayer(),
    unusedMessageLookupLayer,
    Layer.mock(TaskInputStorage, { isRecipient: () => Effect.succeed(false) }),
    familyStorageHarness().layer,
    Layer.mock(CakeSessionRuntimes, {
      acquireSession: () =>
        Effect.fail(
          new PiSessionError({ operation: "acquireSession", message: "Test runtime unavailable" }),
        ),
    }),
  );

it.effect.each([CAKE_CHAT_TODO_SCOPE, "/project"])(
  "holds only the owning chat's session report and survives dismissal/retry in %s",
  (scope) =>
    Effect.gen(function* () {
      const recipient =
        scope === CAKE_CHAT_TODO_SCOPE ? CAKE_CHAT_SESSION_ID : projectChatSessionId(scope);
      const other =
        scope === CAKE_CHAT_TODO_SCOPE ? projectChatSessionId("/project") : CAKE_CHAT_SESSION_ID;
      const item = yield* todos.create(scope, {
        title: "Worker task",
        description: "In progress",
        needsAttention: true,
        attentionReason: "Choose the worker’s next step",
        associations: [{ kind: "session", sessionId: "worker", title: "Worker" }],
      });
      const held = report(recipient);
      expect(yield* attention.hold(report(other), { sessionId: "worker" })).toBe(false);
      expect(yield* attention.hold(held, { sessionId: "worker" })).toBe(true);
      const flagged = yield* todos.read(scope, item.id);
      expect(flagged).toMatchObject({ needsAttention: true, state: "open", revision: 0 });
      expect((yield* reports.list(recipient, {})).total).toBe(0);
      expect((yield* Effect.result(reports.read(recipient, { id: held.id })))._tag).toBe("Failure");
      yield* todos.mutateUser(scope, {
        _tag: "SetAttention",
        id: item.id,
        expectedRevision: flagged.revision,
        needsAttention: false,
      });
      expect(yield* attention.hold(held, { sessionId: "worker" })).toBe(true);
      expect(yield* todos.read(scope, item.id)).toMatchObject({
        state: "open",
        needsAttention: false,
        revision: 1,
        associations: item.associations,
      });
      expect((yield* (yield* SessionFamilyStorage).state()).deferredReferences).toEqual([
        { ...held, attentionTodoId: item.id },
      ]);
    }).pipe(Effect.provide(layer())),
);

it.effect(
  "orders explicit requests, not report arrivals, without reviving dismissed attention",
  () =>
    Effect.gen(function* () {
      const scope = CAKE_CHAT_TODO_SCOPE;
      const newer = yield* todos.create(scope, {
        title: "Second result",
        description: "Working",
        associations: [{ kind: "session", sessionId: "second-worker", title: "Second" }],
      });
      const older = yield* todos.create(scope, {
        title: "First result",
        description: "Working",
        associations: [{ kind: "session", sessionId: "first-worker", title: "First" }],
      });
      yield* todos.update(scope, {
        id: older.id,
        expectedRevision: older.revision,
        needsAttention: true,
        attentionReason: "Choose the first worker’s next step",
      });
      yield* todos.update(scope, {
        id: newer.id,
        expectedRevision: newer.revision,
        needsAttention: true,
        attentionReason: "Choose the second worker’s next step",
      });
      const firstReport = report(CAKE_CHAT_SESSION_ID);
      const secondReport = report(CAKE_CHAT_SESSION_ID);
      yield* attention.hold(firstReport, { sessionId: "first-worker" });
      yield* attention.hold(secondReport, { sessionId: "second-worker" });
      const first = yield* todos.read(scope, older.id);
      expect(first.attentionSequence).toBe(1);
      expect((yield* todos.read(scope, newer.id)).attentionSequence).toBe(2);
      yield* todos.mutateUser(scope, {
        _tag: "SetAttention",
        id: first.id,
        expectedRevision: first.revision,
        needsAttention: false,
      });
      yield* attention.hold(firstReport, { sessionId: "first-worker" });
      expect(yield* todos.read(scope, older.id)).toMatchObject({
        needsAttention: false,
        attentionSequence: 1,
      });
      expect(
        yield* attention.hold(report(CAKE_CHAT_SESSION_ID), {
          sessionId: "first-worker",
        }),
      ).toBe(false);
      const dismissed = yield* todos.read(scope, older.id);
      expect(dismissed).toMatchObject({ needsAttention: false, attentionSequence: 1 });
      yield* todos.update(scope, {
        id: older.id,
        expectedRevision: dismissed.revision,
        needsAttention: true,
        attentionReason: "Approve the revised scope",
      });
      expect(yield* todos.read(scope, older.id)).toMatchObject({
        needsAttention: true,
        attentionSequence: 3,
      });
      expect((yield* todos.read(scope, newer.id)).attentionSequence).toBe(2);
    }).pipe(Effect.provide(layer())),
);

it.effect("holds public-worker reports by handle, not private Pi session identity", () =>
  Effect.gen(function* () {
    const item = yield* todos.create(CAKE_CHAT_TODO_SCOPE, {
      title: "Research",
      description: "In progress",
      needsAttention: true,
      attentionReason: "Choose a research direction",
      associations: [
        {
          kind: "subagent",
          parentSessionId: CAKE_CHAT_SESSION_ID,
          handleId: "00000000-0000-4000-8000-000000000099",
          title: "Research",
        },
      ],
    });
    const held = {
      ...report(CAKE_CHAT_SESSION_ID),
      source: {
        kind: "subagent" as const,
        handleId: "00000000-0000-4000-8000-000000000099",
        sessionId: "private-pi-id",
        task: "Read-only contextual investigation. User just launched a human Side Chat. ".repeat(
          20,
        ),
        status: "complete",
        messageId: "final",
      },
    };
    expect(
      yield* attention.hold(held, {
        sessionId: CAKE_CHAT_SESSION_ID,
        subagent: {
          parentSessionId: CAKE_CHAT_SESSION_ID,
          handleId: "00000000-0000-4000-8000-000000000099",
        },
      }),
    ).toBe(true);
    expect((yield* todos.read(CAKE_CHAT_TODO_SCOPE, item.id)).attentionReason).toBe(
      "Choose a research direction",
    );
    expect(
      (yield* (yield* SessionFamilyStorage).state()).deferredReferences?.[0]?.attentionTodoId,
    ).toBe(item.id);
  }).pipe(Effect.provide(layer())),
);

it.effect("a failed activation retains the pill and original; stale clicks cannot admit it", () =>
  Effect.gen(function* () {
    const item = yield* todos.create(CAKE_CHAT_TODO_SCOPE, {
      title: "Worker task",
      description: "In progress",
      needsAttention: true,
      attentionReason: "Choose the worker’s next step",
      associations: [{ kind: "session", sessionId: "worker", title: "Worker" }],
    });
    const held = report(CAKE_CHAT_SESSION_ID);
    yield* attention.hold(held, { sessionId: "worker" });
    expect((yield* Effect.result(attention.activate(CAKE_CHAT_TODO_SCOPE, item.id, 0)))._tag).toBe(
      "Failure",
    );
    expect((yield* Effect.result(attention.activate(CAKE_CHAT_TODO_SCOPE, item.id, 1)))._tag).toBe(
      "Failure",
    );
    expect(yield* todos.read(CAKE_CHAT_TODO_SCOPE, item.id)).toMatchObject({
      needsAttention: true,
      revision: 0,
      state: "open",
    });
    expect((yield* (yield* SessionFamilyStorage).state()).deferredReferences?.[0]).toEqual({
      ...held,
      attentionTodoId: item.id,
    });
  }).pipe(Effect.provide(layer())),
);

it.effect(
  "manual attention without a held report remains pending when its owning runtime is unavailable",
  () =>
    Effect.gen(function* () {
      const item = yield* todos.create(CAKE_CHAT_TODO_SCOPE, {
        title: "Decision",
        description: "Choose one",
        needsAttention: true,
        attentionReason: "Choose a direction",
      });
      expect(
        (yield* Effect.result(attention.activate(CAKE_CHAT_TODO_SCOPE, item.id, item.revision)))
          ._tag,
      ).toBe("Failure");
      expect(yield* todos.read(CAKE_CHAT_TODO_SCOPE, item.id)).toMatchObject({
        state: "open",
        needsAttention: true,
      });
    }).pipe(Effect.provide(layer())),
);
