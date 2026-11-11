import { afterEach, beforeEach, expect, it } from "vitest";
import { Effect } from "effect";
import * as attention from "../../../src/domain/projects/projectTodoAttention";
import * as todos from "../../../src/domain/projects/projectTodos";
import * as reports from "../../../src/domain/conversations/pendingReports";
import * as sessionChats from "../../../src/domain/conversations/sessionChats";
import { projectChatSessionId } from "../../../src/domain/cake-chats/cakeChatLocations";
import { encodeCrossSessionMessage } from "../../../src/contracts/conversations/cross-session-message";
import { SessionFamilyStorage } from "../../../src/services/storage/SessionFamilyStorage";
import { queuedAutomaticInputPart } from "../../../src/services/pi/runtime/internal-input-projection";
import { heldAttentionHarness, originalRef, producer } from "../helpers/heldAttentionHarness";

const scope = "/project";
const recipientSessionId = projectChatSessionId(scope);
const reportId = "4e1ca476-ecd7-4d5b-8721-6c161bb1da35";
const heldReport = {
  id: reportId,
  recipientSessionId,
  responseKey: `request-${reportId}`,
  text: encodeCrossSessionMessage("Implemented and committed.", {
    version: 1,
    messageId: reportId,
    threadId: reportId,
    sequence: 1,
    expectsResponse: false,
    sourceMessageRef: originalRef,
    sender: { sessionId: producer, title: "Worker", kind: "project-session" },
  }),
  resultMessageRef: originalRef,
};

let f: ReturnType<typeof heldAttentionHarness>;
beforeEach(() => {
  f = heldAttentionHarness();
  f.state.streaming = true;
});
afterEach(() => f.runtime.dispose());

const familyState = () =>
  f.runtime.runPromise(
    Effect.gen(function* () {
      return yield* (yield* SessionFamilyStorage).state();
    }),
  );
const read = (id: string) => f.runtime.runPromise(todos.read(scope, id));

/** A held report flags the to-do; the pill click queues behind the running agent. */
async function queueAttentionClick() {
  const item = await f.runtime.runPromise(
    todos.create(scope, {
      title: "Review merge fix",
      needsAttention: true,
      attentionReason: "Review the merge fix",
      description: "Findings",
      associations: [{ kind: "session", sessionId: producer, title: "Worker" }],
    }),
  );
  await f.runtime.runPromise(attention.hold(heldReport, { sessionId: producer }));
  const flagged = await read(item.id);
  await f.runtime.runPromise(attention.activate(scope, item.id, flagged.revision));
  return { item: flagged, submission: f.submissions.at(-1)! };
}

const withdraw = (turnId: string) =>
  f.runtime.runPromise(
    sessionChats
      .removeQueuedMessage({ sessionId: recipientSessionId }, `queued-${turnId}`)
      .pipe(Effect.scoped),
  );

it("queues its own attention input named by the to-do, not a batched update", async () => {
  const { item, submission } = await queueAttentionClick();
  expect(submission.delivery).toBe("follow-up");
  expect(submission.internal).toMatchObject({
    _tag: "AttentionItem",
    todoId: item.id,
    title: "Review merge fix",
  });
  if (submission.internal?._tag !== "AttentionItem") throw new Error("Expected an attention input");
  const row = queuedAutomaticInputPart(submission.internal, {
    id: "queued-row",
    kind: "text",
    role: "user",
    text: submission.text,
    status: "complete",
    deliveryState: "queued",
    queuedInput: {
      itemId: submission.turnId,
      text: submission.text,
      attachments: [],
      renderUserMessageAsMarkdown: false,
    },
  });
  expect(row).toMatchObject({
    text: "Needs attention: Review merge fix (+1 report)",
    queuedInput: { internal: "AttentionItem" },
  });
  expect((await read(item.id)).needsAttention).toBe(false);
});

it("X on the queued row restores the original attention and its held report", async () => {
  const { item, submission } = await queueAttentionClick();
  expect((await familyState()).deferredReferences?.[0]).toMatchObject({ admissions: 1 });
  expect((await familyState()).deferredReferences?.[0]?.attentionTodoId).toBeUndefined();

  await withdraw(submission.turnId);

  expect(await read(item.id)).toMatchObject({
    state: "open",
    needsAttention: true,
    attentionReason: item.attentionReason,
  });
  const [restored] = (await familyState()).deferredReferences ?? [];
  expect(restored).toMatchObject({ id: reportId, attentionTodoId: item.id });
  expect(restored?.admissions).toBeUndefined();
  expect((await familyState()).queuedAttention ?? []).toEqual([]);
  // Held under the to-do again: not in the ordinary inbox, and the next click carries it.
  expect((await f.runtime.runPromise(reports.list(recipientSessionId, {}))).total).toBe(0);
  const reopened = await read(item.id);
  await f.runtime.runPromise(attention.activate(scope, item.id, reopened.revision));
  expect(f.submissions).toHaveLength(2);
  expect(f.submissions[1]?.internal).toMatchObject({
    _tag: "AttentionItem",
    reportNotices: [expect.objectContaining({ id: reportId })],
  });
});

it("X restores a manual attention item that held no reports", async () => {
  const item = await f.runtime.runPromise(
    todos.create(scope, {
      title: "Choose a direction",
      description: "Two options are ready.",
      needsAttention: true,
      attentionReason: "Pick sidebar or tabs",
    }),
  );
  await f.runtime.runPromise(attention.activate(scope, item.id, item.revision));
  const submission = f.submissions.at(-1)!;
  expect(submission.internal).toMatchObject({ _tag: "AttentionItem", title: "Choose a direction" });
  await withdraw(submission.turnId);
  expect(await read(item.id)).toMatchObject({
    needsAttention: true,
    attentionReason: "Pick sidebar or tabs",
  });
  expect((await familyState()).queuedAttention ?? []).toEqual([]);
  expect((await familyState()).deferredReferences).toBeUndefined();
});

it("delivery settles the click as today: attention stays cleared and the report delivered", async () => {
  const { item, submission } = await queueAttentionClick();
  f.receipts.set(submission.turnId, "consumed");
  await f.runtime.runPromise(attention.runQueuedPass());
  expect((await familyState()).queuedAttention ?? []).toEqual([]);
  expect((await read(item.id)).needsAttention).toBe(false);
  const [delivered] = (await familyState()).deferredReferences ?? [];
  expect(delivered).toMatchObject({ id: reportId, admissions: 1 });
  expect(delivered?.attentionTodoId).toBeUndefined();
});

it("a cancel Pi recorded before a restart is restored by the background pass", async () => {
  const { item, submission } = await queueAttentionClick();
  f.receipts.set(submission.turnId, "pending");
  await f.runtime.runPromise(attention.runQueuedPass());
  expect((await familyState()).queuedAttention).toHaveLength(1);
  f.receipts.set(submission.turnId, "canceled");
  await f.runtime.runPromise(attention.runQueuedPass());
  expect((await read(item.id)).needsAttention).toBe(true);
  expect((await familyState()).deferredReferences?.[0]?.attentionTodoId).toBe(item.id);
});

it("restore never overwrites newer to-do state", async () => {
  const { item, submission } = await queueAttentionClick();
  const cleared = await read(item.id);
  await f.runtime.runPromise(
    todos.update(scope, {
      id: item.id,
      expectedRevision: cleared.revision,
      needsAttention: true,
      attentionReason: "Choose a merge strategy",
    }),
  );
  const newer = await read(item.id);
  await withdraw(submission.turnId);
  expect(await read(item.id)).toMatchObject({
    revision: newer.revision,
    needsAttention: true,
    attentionReason: "Choose a merge strategy",
  });
  // The report still waits under the to-do that needs attention.
  expect((await familyState()).deferredReferences?.[0]?.attentionTodoId).toBe(item.id);
});

it("a to-do completed meanwhile stays done; its report returns to the ordinary inbox", async () => {
  const { item, submission } = await queueAttentionClick();
  const cleared = await read(item.id);
  await f.runtime.runPromise(
    todos.update(scope, { id: item.id, expectedRevision: cleared.revision, state: "done" }),
  );
  const done = await read(item.id);
  await withdraw(submission.turnId);
  expect(await read(item.id)).toMatchObject({
    revision: done.revision,
    state: "done",
    needsAttention: false,
  });
  const inbox = await f.runtime.runPromise(reports.list(recipientSessionId, {}));
  expect(inbox.items).toMatchObject([{ id: reportId, admissions: 0 }]);
});
