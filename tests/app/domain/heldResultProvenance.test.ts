import { subagentLink } from "../../../src/contracts/subagents/subagent-reference";
import { appendMessageReferences } from "../../../src/contracts/conversations/message-reference-forwarding";
import { Effect, Layer, ManagedRuntime } from "effect";
import { expect, it } from "vitest";
import { encodeCrossSessionMessage } from "../../../src/contracts/conversations/cross-session-message";
import {
  protectedResponseNotice,
  pendingReportPresentation,
} from "../../../src/contracts/conversations/reference-notification";
import { pendingReportRef } from "../../../src/contracts/conversations/pending-report";
import { SessionFamilyStorage } from "../../../src/services/storage/SessionFamilyStorage";
import { TaskInputStorage } from "../../../src/services/storage/TaskInputStorage";
import { prepareCoordinatorNotice } from "../../../src/domain/conversations/taskInputs";
import { familyStorageHarness } from "../helpers/familyStorageHarness";
import { originalRef, producer } from "../helpers/heldAttentionHarness";

const recipient = "project-chat:recipient";
const responseKey = "request-turn-1";
const exactId = "bc07709c-cd12-48ae-9738-799652dc25a0";
const genericId = "59f835d4-eab3-4a91-bd37-0576bf02b0ec";
export const incidentReport = (exact: boolean) => ({
  id: exact ? exactId : genericId,
  recipientSessionId: recipient,
  responseKey,
  text: encodeCrossSessionMessage(
    exact
      ? appendMessageReferences(protectedResponseNotice, [originalRef])
      : protectedResponseNotice,
    {
      version: 1,
      messageId: exact ? exactId : genericId,
      threadId: exact
        ? "e055e7ea-7b85-4334-9e69-8273fbc27ceb"
        : "b521f0b4-270c-4908-9a06-d6bbfb22f59e",
      sequence: 1,
      expectsResponse: false,
      resultDelivery: "ignore",
      generatedNotice: !exact,
      ...(exact
        ? {
            sourceMessageRef: originalRef,
            replyToMessageId: "e055e7ea-7b85-4334-9e69-8273fbc27ceb",
          }
        : null),
      sender: { sessionId: producer, title: "Task session", kind: "project-session" },
    },
  ),
});

it.each([false, true])(
  "retains the exact incident pair once, independent of source arrival order (%s), across restart",
  async (exactFirst) => {
    const fixture = familyStorageHarness();
    const runtime = ManagedRuntime.make(fixture.layer);
    await runtime.runPromise(
      Effect.gen(function* () {
        const storage = yield* SessionFamilyStorage;
        yield* storage.deferReferenceNotice({
          ...incidentReport(exactFirst),
          attentionTodoId: "todo",
        });
        yield* storage.deferReferenceNotice(incidentReport(!exactFirst));
        const reports = (yield* storage.state()).deferredReferences ?? [];
        expect(reports).toHaveLength(1);
        expect(reports[0]).toMatchObject({
          attentionTodoId: "todo",
          resultMessageRef: originalRef,
        });
        expect(pendingReportPresentation(reports).notices[0]?.crossSession?.sourceMessageRef).toBe(
          originalRef,
        );
        // Same sender and even same original entry are insufficient to conflate another turn.
        yield* storage.deferReferenceNotice({
          ...incidentReport(true),
          id: "distinct",
          responseKey: "request-turn-2",
        });
        expect((yield* storage.state()).deferredReferences).toHaveLength(2);
      }),
    );
    await runtime.dispose();
    const restarted = ManagedRuntime.make(familyStorageHarness(fixture.files).layer);
    try {
      await restarted.runPromise(
        Effect.gen(function* () {
          const storage = yield* SessionFamilyStorage;
          const reports = (yield* storage.state()).deferredReferences ?? [];
          expect(pendingReportRef(reports[0]!)).toBe(originalRef);
          yield* storage.acknowledgeReports([
            {
              id: reports[0]!.id,
              recipientSessionId: recipient,
              assistantPartId: "visible-answer",
              disposition: "dismissed",
            },
          ]);
          yield* storage.deferReferenceNotice(incidentReport(false));
          expect((yield* storage.state()).deferredReferences).toHaveLength(1);
        }),
      );
    } finally {
      await restarted.dispose();
    }
  },
);

it("upgrades only the same worker response from conversation-only provenance to its exact final entry", async () => {
  const runtime = ManagedRuntime.make(familyStorageHarness().layer);
  try {
    await runtime.runPromise(
      Effect.gen(function* () {
        const storage = yield* SessionFamilyStorage;
        const source = {
          kind: "subagent" as const,
          handleId: "0a1d0405-5e34-4b74-8b3a-12d5df4b7620",
          sessionId: "private-pi",
          task: "Research",
          status: "complete",
        };
        const report = {
          id: "worker-response",
          recipientSessionId: recipient,
          source,
          text: "Legacy worker status",
        };
        yield* storage.deferReferenceNotice(report);
        yield* storage.deferReferenceNotice({
          ...report,
          source: { ...source, messageId: "52a9cef5" },
          text: "Exact final result",
        });
        const retained = (yield* storage.state()).deferredReferences ?? [];
        expect(retained).toHaveLength(1);
        expect(retained[0]?.resultMessageRef).toBe(
          subagentLink(recipient, source.handleId, "52a9cef5"),
        );
        expect(retained[0]?.source?.messageId).toBe("52a9cef5");
        expect(retained[0]?.text).toBe("Exact final result");
      }),
    );
  } finally {
    await runtime.dispose();
  }
});

it("preserves truthful generated lifecycle status rather than fabricating an unreferenced response", async () => {
  const metadata = {
    version: 1 as const,
    messageId: genericId,
    threadId: exactId,
    sequence: 1,
    expectsResponse: false,
    generatedNotice: true,
    sender: { sessionId: producer, title: "Worker", kind: "project-session" as const },
  };
  const notice = encodeCrossSessionMessage(`Session ${producer} — no result`, metadata);
  expect(
    await Effect.runPromise(
      prepareCoordinatorNotice(recipient, notice).pipe(
        Effect.provide(
          Layer.mock(TaskInputStorage, {
            isRecipient: () => Effect.succeed(true),
          }),
        ),
      ),
    ),
  ).toBe(notice);
});
