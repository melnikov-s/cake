import { expect, it } from "vitest";
import { Effect } from "effect";
import * as attention from "../../../src/domain/projects/projectTodoAttention";
import * as todos from "../../../src/domain/projects/projectTodos";
import * as reports from "../../../src/domain/conversations/pendingReports";
import { projectChatSessionId } from "../../../src/domain/cake-chats/cakeChatLocations";
import { encodeCrossSessionMessage } from "../../../src/contracts/conversations/cross-session-message";
import {
  addReferenceNotifications,
  pendingReportPage,
  pendingReportPresentation,
} from "../../../src/contracts/conversations/reference-notification";
import { SessionFamilyStorage } from "../../../src/services/storage/SessionFamilyStorage";
import { passiveNoticeParts } from "../../../src/services/pi/runtime/internal-input-projection";
import { familyStorageHarness } from "../helpers/familyStorageHarness";
import { heldAttentionHarness, originalRef, producer } from "../helpers/heldAttentionHarness";

const scope = "/project";
const recipientSessionId = projectChatSessionId(scope);
// The observed duplicate: distinct request/thread correlations, one immutable Pi original.
const source = "cake://session/4e17c039-77a4-4ec3-a34d-15aae00f01fa?message=0b287a41";
const report = (id: string, resultMessageRef = source) => ({
  id,
  recipientSessionId,
  responseKey: `request-${id}`,
  text: encodeCrossSessionMessage("Validating test counts Implemented and committed: 959b0625", {
    version: 1,
    messageId: id,
    threadId: id,
    replyToMessageId: id,
    sequence: 1,
    expectsResponse: false,
    generatedNotice: false,
    resultDelivery: "ignore",
    sourceMessageRef: resultMessageRef,
    sender: {
      sessionId: producer,
      title: "Remove quadratic to-do classification",
      kind: "project-session",
    },
  }),
});
const firstId = "4e1ca476-ecd7-4d5b-8721-6c161bb1da35";
const secondId = "621ecc39-ab6f-4131-8785-6bf610fbf661";

it("admits existing duplicate pending originals once under concurrent activation, retains both ACKs, and retries without replay", async () => {
  const f = heldAttentionHarness();
  try {
    const item = await f.runtime.runPromise(
      todos.create(scope, {
        title: "Remove quadratic to-do classification",
        description: "Review findings",
        needsAttention: true,
        attentionReason: "Review findings",
        associations: [{ kind: "session", sessionId: producer, title: "Worker" }],
      }),
    );
    for (const id of [firstId, secondId])
      await f.runtime.runPromise(attention.hold(report(id, originalRef), { sessionId: producer }));
    const flagged = await f.runtime.runPromise(todos.read(scope, item.id));
    f.state.publishFail = true; // durable admission succeeded, attention mutation has not
    const results = await Promise.allSettled([
      f.runtime.runPromise(attention.activate(scope, item.id, flagged.revision)),
      f.runtime.runPromise(attention.activate(scope, item.id, flagged.revision)),
    ]);
    expect(results.every((result) => result.status === "rejected")).toBe(true);
    expect(f.submissions).toHaveLength(1);
    const admitted = f.submissions[0]!;
    expect(passiveNoticeParts(admitted.internal)).toHaveLength(1);
    expect(admitted.text).toContain(`Report ${firstId}`);
    expect(admitted.text).toContain(`Report ${secondId}`);
    f.receipts.set(admitted.turnId, "consumed");
    f.state.publishFail = false;
    await f.runtime.runPromise(attention.activate(scope, item.id, flagged.revision));
    expect(f.submissions).toHaveLength(1);
    const inbox = await f.runtime.runPromise(reports.list(recipientSessionId, {}));
    expect(inbox.items.map((entry) => entry.id)).toEqual([firstId, secondId]);
    for (const id of [firstId, secondId]) {
      const pending = await f.runtime.runPromise(reports.read(recipientSessionId, { id }));
      expect(pending.ref).toBe(originalRef);
    }
    await expect(
      f.runtime.runPromise(
        reports
          .acknowledge(recipientSessionId, {
            ids: [firstId, secondId],
            disposition: "communicated",
            communicatedText: "Planned answer",
          })
          .pipe(Effect.scoped),
      ),
    ).rejects.toThrow("Emit the user-facing report");
    const state = await f.runtime.runPromise(
      Effect.gen(function* () {
        return yield* (yield* SessionFamilyStorage).state();
      }),
    );
    expect(state.handledReports ?? []).toHaveLength(0);
    expect(state.deferredReferences?.every((entry) => (entry.admissions ?? 0) > 0)).toBe(true);
    expect(pendingReportPresentation(state.deferredReferences ?? []).notices).toHaveLength(0);
  } finally {
    await f.runtime.dispose();
  }
});

it("shares presentation admission across pages/restarts/new correlations without consuming deliveries or ACKs", async () => {
  const harness = familyStorageHarness();
  await Effect.runPromise(
    Effect.gen(function* () {
      const storage = yield* SessionFamilyStorage;
      const first = report(firstId);
      const second = report(secondId);
      yield* Effect.all(
        [storage.deferReferenceNotice(first), storage.deferReferenceNotice(second)],
        { concurrency: "unbounded" },
      );
      let pending = (yield* storage.state()).deferredReferences ?? [];
      expect(pending).toHaveLength(2);
      expect(pendingReportPresentation(pending).notices).toHaveLength(1);
      yield* storage.markReferenceAdmissions([first.id]); // even if its alias was outside a page
      pending = (yield* storage.state()).deferredReferences ?? [];
      expect(pending.every((entry) => entry.admissions === 1)).toBe(true);
      const late = report(crypto.randomUUID());
      yield* storage.deferReferenceNotice(late);
      expect(
        (yield* storage.state()).deferredReferences?.find((entry) => entry.id === late.id)
          ?.admissions,
      ).toBe(1);
      yield* storage.acknowledgeReports([
        {
          id: late.id,
          recipientSessionId,
          assistantPartId: "visible-answer",
          disposition: "communicated",
        },
      ]);
      // Each delivery remains independently acknowledged. One ACK cannot consume its alias.
      yield* storage.acknowledgeReports([
        {
          id: first.id,
          recipientSessionId,
          assistantPartId: "visible-answer",
          disposition: "communicated",
        },
      ]);
      expect((yield* storage.state()).deferredReferences?.map((entry) => entry.id)).toEqual([
        second.id,
      ]);
      yield* storage.acknowledgeReports([
        {
          id: second.id,
          recipientSessionId,
          assistantPartId: "visible-answer",
          disposition: "communicated",
        },
      ]);
      const reopened = yield* Effect.gen(function* () {
        return yield* SessionFamilyStorage;
      }).pipe(Effect.provide(familyStorageHarness(harness.files).layer));
      expect(
        (yield* reopened.state()).handledReports?.map((receipt) => receipt.resultMessageRef),
      ).toEqual([source, source, source]);
      const alias = report(crypto.randomUUID());
      yield* reopened.deferReferenceNotice(alias);
      // A new request still owes explicit handling, but does not create a second result card.
      pending = (yield* reopened.state()).deferredReferences ?? [];
      expect(pending).toHaveLength(1);
      expect(pending[0]?.admissions).toBe(1);
      expect(pendingReportPresentation(pendingReportPage(pending)).notices).toHaveLength(0);
      expect(addReferenceNotifications("Review", pending)).toContain(`Report ${alias.id}`);
      // New originals from that session and other recipients remain independent.
      yield* reopened.deferReferenceNotice(
        report(crypto.randomUUID(), source.replace("0b287a41", "next-message")),
      );
      yield* reopened.deferReferenceNotice({
        ...report(crypto.randomUUID()),
        recipientSessionId: "other-chat",
      });
      pending = (yield* reopened.state()).deferredReferences ?? [];
      expect(pendingReportPresentation(pending).notices).toHaveLength(2);
      // Replaying an already acknowledged delivery settles it, rather than recreating an obligation.
      yield* reopened.deferReferenceNotice(first);
      expect((yield* reopened.state()).deferredReferences).toHaveLength(3);
    }).pipe(Effect.provide(harness.layer)),
  );
});

it("failed source reads and canceled admissions retain both originals for a successful retry", async () => {
  const f = heldAttentionHarness();
  try {
    const item = await f.runtime.runPromise(
      todos.create(scope, {
        title: "Review",
        description: "Result",
        needsAttention: true,
        attentionReason: "Review the result",
        associations: [{ kind: "session", sessionId: producer, title: "Worker" }],
      }),
    );
    for (const id of [firstId, secondId])
      await f.runtime.runPromise(attention.hold(report(id, originalRef), { sessionId: producer }));
    const flagged = await f.runtime.runPromise(todos.read(scope, item.id));
    f.state.sourceAvailable = false;
    await expect(
      f.runtime.runPromise(attention.activate(scope, item.id, flagged.revision)),
    ).rejects.toThrow("Source temporarily unavailable");
    expect(f.submissions).toHaveLength(0);
    f.state.sourceAvailable = true;
    f.state.cancelOnSubmit = true;
    await expect(
      f.runtime.runPromise(attention.activate(scope, item.id, flagged.revision)),
    ).rejects.toThrow("canceled");
    const state = await f.runtime.runPromise(
      Effect.gen(function* () {
        return yield* (yield* SessionFamilyStorage).state();
      }),
    );
    expect(state.deferredReferences).toHaveLength(2);
    expect(
      state.deferredReferences?.every(
        (entry) => !entry.admissions && entry.attentionTodoId === item.id,
      ),
    ).toBe(true);
    expect(state.handledReports ?? []).toHaveLength(0);
    f.state.cancelOnSubmit = false;
    await f.runtime.runPromise(attention.activate(scope, item.id, flagged.revision));
    expect(f.submissions).toHaveLength(2); // one canceled, one consumed candidate
    expect(passiveNoticeParts(f.submissions[1]?.internal)).toHaveLength(1);
  } finally {
    await f.runtime.dispose();
  }
});
