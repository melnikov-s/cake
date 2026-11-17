import { it } from "@effect/vitest";
import { expect } from "vitest";
import { Effect, Schema } from "effect";
import { ProjectTodos } from "../../../src/contracts/projects/project-todos";
import * as attention from "../../../src/domain/projects/projectTodoAttention";
import * as todos from "../../../src/domain/projects/projectTodos";
import * as reports from "../../../src/domain/conversations/pendingReports";
import { encodeCrossSessionMessage } from "../../../src/contracts/conversations/cross-session-message";
import { projectChatSessionId } from "../../../src/domain/cake-chats/cakeChatLocations";
import { SessionFamilyStorage } from "../../../src/services/storage/SessionFamilyStorage";
import { heldAttentionHarness, producer } from "../helpers/heldAttentionHarness";

const scope = "/project";
const recipientSessionId = projectChatSessionId(scope);
const reason = "Choose the next step after reviewing the findings";
const request = (attentionRequestId: string) => ({
  needsAttention: true,
  attentionReason: reason,
  attentionRequestId,
});
const report = (id: string) => ({
  id,
  recipientSessionId,
  text: encodeCrossSessionMessage("Findings for review", {
    version: 1,
    messageId: id,
    threadId: id,
    sequence: 1,
    expectsResponse: false,
    sender: { sessionId: producer, title: "Worker", kind: "project-session" },
  }),
});
const create = () =>
  todos.create(scope, {
    title: "Review findings",
    description: "Findings ready",
    ...request("first-result"),
    associations: [{ kind: "session", sessionId: producer, title: "Worker" }],
  });
const persistedTodos = Effect.gen(function* () {
  return Schema.decodeUnknownSync(ProjectTodos)(
    JSON.parse(JSON.stringify(yield* todos.list(scope))),
  );
});
const familyState = Effect.gen(function* () {
  return yield* (yield* SessionFamilyStorage).state();
});

it.effect.each(["open", "dismiss"] as const)(
  "a new explicit request after %s holds its report, while duplicate and quiet arrivals never reflag",
  (action) =>
    Effect.gen(function* () {
      const f = yield* Effect.acquireRelease(Effect.sync(heldAttentionHarness), (f) =>
        Effect.promise(() => f.runtime.dispose()),
      );
      yield* Effect.promise(async () => {
        let item = await f.runtime.runPromise(create());
        const first = report("cda4140b-3671-4183-9398-eab5ec35e434");
        const second = report("621ecc39-ab6f-4131-8785-6bf610fbf661");
        await f.runtime.runPromise(attention.hold(first, { sessionId: producer }));
        if (action === "open") {
          const opened = await f.runtime.runPromise(
            attention.activate(scope, item.id, item.revision),
          );
          f.receipts.set(opened.responseTurnId, "consumed");
        } else {
          await f.runtime.runPromise(
            todos.mutateUser(scope, {
              _tag: "SetAttention",
              id: item.id,
              expectedRevision: item.revision,
              needsAttention: false,
            }),
          );
        }
        item = await f.runtime.runPromise(todos.read(scope, item.id));
        item = await f.runtime.runPromise(
          todos.update(scope, {
            id: item.id,
            expectedRevision: item.revision,
            ...request("first-result"),
          }),
        );
        expect(item.needsAttention).toBe(false);
        expect(await f.runtime.runPromise(attention.hold(first, { sessionId: producer }))).toBe(
          true,
        );
        // A distinct background result alone is not a human request.
        expect(await f.runtime.runPromise(attention.hold(second, { sessionId: producer }))).toBe(
          false,
        );
        expect((await f.runtime.runPromise(todos.read(scope, item.id))).needsAttention).toBe(false);
        item = await f.runtime.runPromise(
          todos.update(scope, {
            id: item.id,
            expectedRevision: item.revision,
            ...request("second-result"),
          }),
        );
        expect(item.needsAttention).toBe(true);
        expect(await f.runtime.runPromise(attention.hold(second, { sessionId: producer }))).toBe(
          true,
        );
        const held = await f.runtime.runPromise(familyState);
        expect(
          held.deferredReferences?.find((entry) => entry.id === second.id)?.attentionTodoId,
        ).toBe(item.id);
        expect(
          (await f.runtime.runPromise(reports.list(recipientSessionId, {}))).items.some(
            (entry) => entry.id === second.id,
          ),
        ).toBe(false);
        await f.runtime.runPromise(attention.activate(scope, item.id, item.revision));
        expect(
          (await f.runtime.runPromise(reports.list(recipientSessionId, {}))).items.map(
            (entry) => entry.id,
          ),
        ).toEqual(expect.arrayContaining([first.id, second.id]));
        const last = f.submissions.at(-1)!;
        expect(last.text).toContain(`Report ${second.id}`);
        expect(last.internal).toMatchObject({
          _tag: "AttentionItem",
          reportNotices: expect.arrayContaining([expect.objectContaining({ id: second.id })]),
        });
      });
    }),
);

it.effect(
  "canceling an older click cannot restore a newer dismissed request with the same reason",
  () =>
    Effect.gen(function* () {
      const f = yield* Effect.acquireRelease(Effect.sync(heldAttentionHarness), (f) =>
        Effect.promise(() => f.runtime.dispose()),
      );
      yield* Effect.promise(async () => {
        f.state.streaming = true;
        let item = await f.runtime.runPromise(create());
        const held = report("cda4140b-3671-4183-9398-eab5ec35e434");
        await f.runtime.runPromise(attention.hold(held, { sessionId: producer }));
        const opened = await f.runtime.runPromise(
          attention.activate(scope, item.id, item.revision),
        );
        expect((await f.runtime.runPromise(familyState)).queuedAttention?.[0]).toMatchObject({
          attentionRequestId: "first-result",
        });
        item = await f.runtime.runPromise(todos.read(scope, item.id));
        item = await f.runtime.runPromise(
          todos.update(scope, {
            id: item.id,
            expectedRevision: item.revision,
            ...request("second-result"),
          }),
        );
        item = (
          await f.runtime.runPromise(
            todos.mutateUser(scope, {
              _tag: "SetAttention",
              id: item.id,
              expectedRevision: item.revision,
              needsAttention: false,
            }),
          )
        ).items[0]!;
        f.receipts.set(opened.responseTurnId, "canceled");
        await f.runtime.runPromise(attention.runQueuedPass());
        expect(await f.runtime.runPromise(todos.read(scope, item.id))).toMatchObject({
          revision: item.revision,
          needsAttention: false,
          attentionRequestId: "second-result",
        });
        expect((await f.runtime.runPromise(familyState)).queuedAttention ?? []).toEqual([]);
        // No remaining attention owns this canceled admission: return it to the quiet inbox.
        expect(
          (await f.runtime.runPromise(reports.list(recipientSessionId, {}))).items,
        ).toMatchObject([{ id: held.id, admissions: 0 }]);
      });
    }),
);

it.effect(
  "a canceled identified request restores after reopening persisted application and family state",
  () =>
    Effect.gen(function* () {
      const f = yield* Effect.acquireRelease(Effect.sync(heldAttentionHarness), (f) =>
        Effect.promise(() => f.runtime.dispose()),
      );
      const saved = yield* Effect.promise(async () => {
        let item = await f.runtime.runPromise(create());
        const held = report("cda4140b-3671-4183-9398-eab5ec35e434");
        await f.runtime.runPromise(attention.hold(held, { sessionId: producer }));
        const opened = await f.runtime.runPromise(
          attention.activate(scope, item.id, item.revision),
        );
        item = await f.runtime.runPromise(todos.read(scope, item.id));
        // Copy is not identity: retain the newer wording on restoring this same request.
        await f.runtime.runPromise(
          todos.update(scope, {
            id: item.id,
            expectedRevision: item.revision,
            attentionReason: "Choose between the revised options",
          }),
        );
        const initialTodos = await f.runtime.runPromise(persistedTodos);
        await f.runtime.dispose();
        return {
          initialTodos,
          files: f.storage.files,
          turnId: opened.responseTurnId,
          id: item.id,
          reportId: held.id,
        };
      });
      const reopened = yield* Effect.acquireRelease(
        Effect.sync(() => heldAttentionHarness(saved)),
        (f) => Effect.promise(() => f.runtime.dispose()),
      );
      yield* Effect.promise(async () => {
        reopened.receipts.set(saved.turnId, "canceled");
        await reopened.runtime.runPromise(attention.runQueuedPass());
        const restored = await reopened.runtime.runPromise(todos.read(scope, saved.id));
        expect(restored).toMatchObject({
          needsAttention: true,
          attentionRequestId: "first-result",
          attentionReason: "Choose between the revised options",
        });
        expect(
          (await reopened.runtime.runPromise(familyState)).deferredReferences?.[0],
        ).toMatchObject({ id: saved.reportId, attentionTodoId: saved.id });
        await reopened.runtime.runPromise(attention.activate(scope, saved.id, restored.revision));
        expect(reopened.submissions[0]?.text).toContain(`Report ${saved.reportId}`);
      });
    }),
);
