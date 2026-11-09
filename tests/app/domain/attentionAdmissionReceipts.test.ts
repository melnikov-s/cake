import { expect, it } from "vitest";
import { Effect, Deferred } from "effect";
import * as attention from "../../../src/domain/projects/projectTodoAttention";
import { projectChatSessionId } from "../../../src/domain/cake-chats/cakeChatLocations";
import * as todos from "../../../src/domain/projects/projectTodos";
import { SessionFamilyStorage } from "../../../src/services/storage/SessionFamilyStorage";
import { heldAttentionHarness, originalRef, producer } from "../helpers/heldAttentionHarness";

const scope = "/project";
it("retries the same durable request after an interrupted handoff without another prompt or premature communication ACK", async () => {
  const f = heldAttentionHarness();
  try {
    const item = await f.runtime.runPromise(
      todos.create(scope, {
        title: "Review",
        description: "Findings",
        needsAttention: true,
        attentionReason: "Review findings",
      }),
    );
    f.state.publishFail = true;
    await expect(
      f.runtime.runPromise(attention.activate(scope, item.id, item.revision)),
    ).rejects.toThrow("Interrupted after durable admission");
    expect(f.submissions).toHaveLength(1);
    expect(f.submissions[0]?.delivery).toBe("prompt");
    expect((await f.runtime.runPromise(todos.read(scope, item.id))).needsAttention).toBe(true);
    // Pi-owned receipt survives interruption; activation has no local in-flight memory.
    f.receipts.set(f.submissions[0]!.turnId, "consumed");
    f.state.publishFail = false;
    const result = await f.runtime.runPromise(attention.activate(scope, item.id, item.revision));
    expect(result.resultSource).toBe("history");
    expect(f.submissions).toHaveLength(1);
    expect((await f.runtime.runPromise(todos.read(scope, item.id))).needsAttention).toBe(false);
    expect(
      (
        await f.runtime.runPromise(
          Effect.gen(function* () {
            return yield* (yield* SessionFamilyStorage).state();
          }),
        )
      ).handledReports ?? [],
    ).toHaveLength(0);
  } finally {
    await f.runtime.dispose();
  }
});

it("newly consumed attention receipts still wait for projection instead of searching history", async () => {
  const f = heldAttentionHarness();
  try {
    const item = await f.runtime.runPromise(
      todos.create(scope, {
        title: "Review",
        description: "",
        needsAttention: true,
        attentionReason: "Review findings",
      }),
    );
    f.state.afterSubmit = () => f.receipts.set(f.submissions[0]!.turnId, "consumed");
    const result = await f.runtime.runPromise(attention.activate(scope, item.id, item.revision));
    expect(result.resultSource).toBe("incoming");
  } finally {
    await f.runtime.dispose();
  }
});

it("canceled admission preserves attention; retry gets a new receipt while X dismisses without delivery", async () => {
  const f = heldAttentionHarness();
  try {
    const item = await f.runtime.runPromise(
      todos.create(scope, {
        title: "Review",
        description: "Findings",
        needsAttention: true,
        attentionReason: "Review findings",
      }),
    );
    f.state.cancelOnSubmit = true;
    await expect(
      f.runtime.runPromise(attention.activate(scope, item.id, item.revision)),
    ).rejects.toThrow("canceled");
    expect((await f.runtime.runPromise(todos.read(scope, item.id))).needsAttention).toBe(true);
    f.state.cancelOnSubmit = false;
    const result = await f.runtime.runPromise(attention.activate(scope, item.id, item.revision));
    expect(result.resultSource).toBe("incoming");
    expect(f.submissions).toHaveLength(2);
    expect(f.submissions[0]?.turnId).not.toBe(f.submissions[1]?.turnId);
    const next = await f.runtime.runPromise(
      todos.create(scope, {
        title: "Dismiss",
        description: "Findings",
        needsAttention: true,
        attentionReason: "No delivery",
      }),
    );
    await f.runtime.runPromise(
      todos.mutateUser(scope, {
        _tag: "SetAttention",
        id: next.id,
        expectedRevision: next.revision,
        needsAttention: false,
      }),
    );
    await expect(
      f.runtime.runPromise(attention.activate(scope, next.id, next.revision)),
    ).rejects.toThrow("changed");
    expect(f.submissions).toHaveLength(2);
    expect((await f.runtime.runPromise(todos.read(scope, next.id))).needsAttention).toBe(false);
  } finally {
    await f.runtime.dispose();
  }
});

it("late exact provenance does not revive X-dismissed attention; a later independent report survives earlier admission", async () => {
  const f = heldAttentionHarness();
  try {
    const item = await f.runtime.runPromise(
      todos.create(scope, {
        title: "Results",
        description: "Review",
        associations: [{ kind: "session", sessionId: producer, title: "Worker" }],
      }),
    );
    const recipientSessionId = projectChatSessionId(scope);
    const generic = {
      id: "generated",
      recipientSessionId,
      responseKey: "request-1",
      text: "Legacy status without an exact original",
    };
    await f.runtime.runPromise(attention.hold(generic, { sessionId: producer }));
    const flagged = await f.runtime.runPromise(todos.read(scope, item.id));
    await f.runtime.runPromise(
      todos.mutateUser(scope, {
        _tag: "SetAttention",
        id: item.id,
        expectedRevision: flagged.revision,
        needsAttention: false,
      }),
    );
    await f.runtime.runPromise(
      attention.hold(
        { ...generic, id: "exact", resultMessageRef: originalRef },
        { sessionId: producer },
      ),
    );
    expect((await f.runtime.runPromise(todos.read(scope, item.id))).needsAttention).toBe(false);
    const dismissed = await f.runtime.runPromise(todos.read(scope, item.id));
    await f.runtime.runPromise(
      todos.update(scope, {
        id: item.id,
        expectedRevision: dismissed.revision,
        needsAttention: true,
        attentionReason: "Review findings",
      }),
    );
    const opened = await f.runtime.runPromise(todos.read(scope, item.id));
    const entered = Deferred.makeUnsafe<void>();
    const gate = Deferred.makeUnsafe<void>();
    f.state.beforeSubmit = Deferred.succeed(entered, undefined).pipe(
      Effect.andThen(Deferred.await(gate)),
    );
    const activating = f.runtime.runPromise(attention.activate(scope, item.id, opened.revision));
    await Effect.runPromise(Deferred.await(entered));
    await f.runtime.runPromise(
      Effect.gen(function* () {
        yield* (yield* SessionFamilyStorage).deferReferenceNotice({
          id: "later",
          recipientSessionId,
          responseKey: "request-2",
          text: "Independent later report",
          attentionTodoId: item.id,
        });
      }),
    );
    await Effect.runPromise(Deferred.succeed(gate, undefined));
    await activating;
    expect((await f.runtime.runPromise(todos.read(scope, item.id))).needsAttention).toBe(true);
    const pending = await f.runtime.runPromise(
      Effect.gen(function* () {
        return (yield* (yield* SessionFamilyStorage).state()).deferredReferences;
      }),
    );
    expect(pending?.find((report) => report.id === "later")?.attentionTodoId).toBe(item.id);
    expect(pending?.find((report) => report.id === "generated")?.attentionTodoId).toBeUndefined();
    expect(f.submissions).toHaveLength(1);
  } finally {
    await f.runtime.dispose();
  }
});
