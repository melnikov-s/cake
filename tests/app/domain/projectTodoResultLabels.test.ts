import { it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect } from "vitest";
import {
  CAKE_CHAT_TODO_SCOPE,
  emptyProjectTodos,
  projectTodoAttentionDetail,
  type ProjectTodo,
} from "../../../src/contracts/projects/project-todos";
import * as attention from "../../../src/domain/projects/projectTodoAttention";
import * as todos from "../../../src/domain/projects/projectTodos";
import { SessionFamilyStorage } from "../../../src/services/storage/SessionFamilyStorage";
import { TaskInputStorage } from "../../../src/services/storage/TaskInputStorage";
import { familyStorageHarness } from "../helpers/familyStorageHarness";
import { projectTodoLayer } from "../helpers/projectTodoHarness";

it.effect.each(
  (["session", "subagent"] as const).flatMap((kind) =>
    ["Investigate Side Chat opening", "T".repeat(67), "T".repeat(68), "L".repeat(512)].map(
      (title) => ({ kind, title }),
    ),
  ),
)(
  "preserves explicit $kind requests regardless of title or worker prompt %#",
  ({ kind, title }) => {
    const subagent = {
      parentSessionId: CAKE_CHAT_TODO_SCOPE,
      handleId: "00000000-0000-4000-8000-000000000002",
    };
    const item: ProjectTodo = {
      id: "00000000-0000-4000-8000-000000000001",
      title,
      description: "Review investigation findings.",
      status: "",
      state: "open",
      needsAttention: true,
      attentionReason: "Choose the next investigation priority",
      revision: 0,
      associations: [
        kind === "subagent"
          ? { kind, ...subagent, title: "Worker" }
          : { kind, sessionId: "worker", title: "Worker" },
      ],
    };
    const storage = familyStorageHarness();
    const layer = Layer.mergeAll(
      storage.layer,
      projectTodoLayer({ initialCakeChatTodos: { ...emptyProjectTodos(), items: [item] } }),
      Layer.mock(TaskInputStorage, {}),
    );
    const report = {
      id: "held-result",
      recipientSessionId: CAKE_CHAT_TODO_SCOPE,
      text: "Read-only contextual investigation. User just launched a human Side Chat. ".repeat(20),
    };
    return Effect.gen(function* () {
      expect(
        yield* attention.hold(report, {
          sessionId: kind === "subagent" ? subagent.parentSessionId : "worker",
          ...(kind === "subagent" ? { subagent } : {}),
        }),
      ).toBe(true);
      const held = yield* todos.read(CAKE_CHAT_TODO_SCOPE, item.id);
      expect(held.attentionReason).toBe(item.attentionReason);
      expect(projectTodoAttentionDetail(held)).toBe(item.attentionReason);
      expect(held.revision).toBe(item.revision);
      expect(held.title).toBe(title);
      expect(held.description).toBe(item.description);
      expect(held.associations).toEqual(item.associations);
      expect(held.needsAttention).toBe(true);
      expect((yield* (yield* SessionFamilyStorage).state()).deferredReferences?.[0]).toMatchObject({
        ...report,
        attentionTodoId: item.id,
      });
    }).pipe(Effect.provide(layer));
  },
);
