import { it } from "@effect/vitest";
import { expect } from "vitest";
import { Effect, Schema } from "effect";
import { CAKE_CHAT_TODO_SCOPE, ProjectTodos } from "../../../src/contracts/projects/project-todos";
import * as todos from "../../../src/domain/projects/projectTodos";
import { projectTodoLayer } from "../helpers/projectTodoHarness";

const reason = "Review the findings and choose the next step";
const request = (attentionRequestId: string) => ({
  needsAttention: true,
  attentionReason: reason,
  attentionRequestId,
});

it.effect.each(["/project", CAKE_CHAT_TODO_SCOPE])(
  "distinct explicit requests with the same display reason reflag after dismissal in %s",
  (scope) =>
    Effect.gen(function* () {
      let item = yield* todos.create(scope, {
        title: "Review findings",
        description: "Results ready",
        ...request("result-one"),
      });
      item = (yield* todos.mutateUser(scope, {
        _tag: "SetAttention",
        id: item.id,
        expectedRevision: item.revision,
        needsAttention: false,
      })).items[0]!;
      item = yield* todos.update(scope, {
        id: item.id,
        expectedRevision: item.revision,
        ...request("result-two"),
      });
      expect(item.needsAttention).toBe(true);
      expect(item).toMatchObject({
        attentionReason: reason,
        attentionRequestId: "result-two",
        attentionSequence: 2,
      });
    }).pipe(Effect.provide(projectTodoLayer())),
);

it.effect(
  "same identified request stays dismissed despite rewording, omission and persisted reload",
  () =>
    Effect.gen(function* () {
      const saved = yield* Effect.gen(function* () {
        const item = yield* todos.create("/project", {
          title: "Review findings",
          description: "Results ready",
          ...request("result-one"),
        });
        return yield* todos.mutateUser("/project", {
          _tag: "SetAttention",
          id: item.id,
          expectedRevision: item.revision,
          needsAttention: false,
        });
      }).pipe(Effect.provide(projectTodoLayer()));
      const persisted = Schema.decodeUnknownSync(ProjectTodos)(JSON.parse(JSON.stringify(saved)));
      yield* Effect.gen(function* () {
        let item = persisted.items[0]!;
        for (const input of [
          request("result-one"),
          { needsAttention: true, attentionReason: "Reworded request" },
        ]) {
          item = yield* todos.update("/project", {
            id: item.id,
            expectedRevision: item.revision,
            ...input,
          });
          expect(item.needsAttention).toBe(false);
        }
        item = yield* todos.update("/project", {
          id: item.id,
          expectedRevision: item.revision,
          ...request("result-two"),
        });
        expect(item.needsAttention).toBe(true);
      }).pipe(Effect.provide(projectTodoLayer({ initialTodos: persisted })));
    }),
);
