import assert from "node:assert/strict";
import { Effect, Layer } from "effect";
import { describe, it } from "vitest";
import {
  forgetProjectSessions,
  reconcileResolvedSessions,
  removeProject,
  renameProject,
  setCakeChatSessionResolved,
  setSessionFastMode,
  setSessionUnread,
  setSessionsResolved,
  setUtilityModel,
  setVscodeServerPath,
  touchProject,
  trustProject,
  revokeProjectTrust,
  upsertProject,
} from "../../../src/domain/application";
import { defaultApplicationState } from "../../../src/domain/application-data";
import { ApplicationState } from "../../../src/services/storage/ApplicationState";
import { ApplicationStorage } from "../../../src/services/storage/ApplicationStorage";

const itEffect = (name: string, body: () => Effect.Effect<void, unknown>) =>
  it(name, () => Effect.runPromise(body()));

const makeLayer = (options?: { failSave?: boolean }) => {
  let persisted = defaultApplicationState();
  const storage = ApplicationStorage.of({
    load: Effect.succeed({ state: persisted, source: "current" as const }),
    save: (state) =>
      options?.failSave
        ? Effect.fail({ _tag: "TestSaveFailure" } as never)
        : Effect.sync(() => {
            persisted = state;
          }),
  });
  return {
    layer: ApplicationState.layer.pipe(Layer.provide(Layer.succeed(ApplicationStorage)(storage))),
    persisted: () => persisted,
  };
};

const run = <A, E>(effect: Effect.Effect<A, E, ApplicationState>) => {
  const test = makeLayer();
  return effect.pipe(Effect.provide(test.layer));
};

describe("Application domain", () => {
  itEffect("creates, touches, renames, and removes Projects with trust revocation", () =>
    run(
      Effect.gen(function* () {
        const created = yield* upsertProject("/work/cake", "cake");
        assert.equal(created.projects.length, 1);
        const addedAt = created.projects[0]!.addedAt;
        const touched = yield* touchProject("/work/cake", "2025-01-01T00:00:00.000Z");
        assert.equal(touched.projects.length, 1);
        assert.equal(touched.projects[0]!.addedAt, addedAt);
        assert.equal(touched.projects[0]!.lastOpenedAt, "2025-01-01T00:00:00.000Z");
        yield* trustProject("/work/cake");
        yield* revokeProjectTrust("/work/cake");
        yield* trustProject("/work/cake");
        const renamed = yield* renameProject("/work/cake", "  Cake desktop  ");
        assert.equal(renamed.projects[0]!.name, "Cake desktop");
        const removed = yield* removeProject("/work/cake");
        assert.deepEqual(removed.projects, []);
        assert.deepEqual(removed.trustedProjectPaths, []);
      }),
    ),
  );

  itEffect("enforces the Project registry bound", () =>
    run(
      Effect.gen(function* () {
        for (let index = 0; index < 200; index++)
          yield* upsertProject(`/project/${index}`, `Project ${index}`);
        const error = yield* Effect.flip(upsertProject("/project/overflow", "Overflow"));
        assert.equal(error._tag, "ApplicationPolicyError");
      }),
    ),
  );

  itEffect("deduplicates trust and enforces its bound", () =>
    run(
      Effect.gen(function* () {
        yield* trustProject("/work/cake");
        const duplicate = yield* trustProject("/work/cake");
        assert.deepEqual(duplicate.trustedProjectPaths, ["/work/cake"]);
        for (let index = 1; index < 200; index++) yield* trustProject(`/work/${index}`);
        const error = yield* Effect.flip(trustProject("/work/overflow"));
        assert.equal(error._tag, "ApplicationPolicyError");
      }),
    ),
  );

  itEffect("preserves resolved, unread, Cake Chat, Fast mode, and forget interactions", () =>
    run(
      Effect.gen(function* () {
        yield* setSessionUnread("session-1", true);
        const resolved = yield* setSessionsResolved(["session-1", "session-1"], true);
        assert.deepEqual(resolved.resolvedSessionIds, ["session-1"]);
        assert.deepEqual(resolved.unreadSessionIds, []);
        yield* setCakeChatSessionResolved("cake-chat-1", true);
        yield* setSessionFastMode("session-1", true);
        const forgotten = yield* forgetProjectSessions(["session-1"]);
        assert.deepEqual(forgotten.resolvedSessionIds, []);
        assert.deepEqual(forgotten.fastModeSessionIds, []);
        assert.deepEqual(forgotten.resolvedCakeChatSessionIds, ["cake-chat-1"]);
      }),
    ),
  );

  itEffect("updates Utility Model and normalizes VS Code path", () =>
    run(
      Effect.gen(function* () {
        const utility = yield* setUtilityModel({
          provider: "openai",
          modelId: "gpt-5-mini",
          thinkingLevel: "low",
        });
        assert.equal(utility.utilityModel?.modelId, "gpt-5-mini");
        const editor = yield* setVscodeServerPath("  /opt/code-server  ");
        assert.equal(editor.vscodeServerPath, "/opt/code-server");
        const cleared = yield* setVscodeServerPath("   ");
        assert.equal(cleared.vscodeServerPath, undefined);
      }),
    ),
  );

  itEffect("reconciles archived Project and Cake Chat sessions", () =>
    run(
      Effect.gen(function* () {
        const state = yield* reconcileResolvedSessions(
          ["project-2", "project-1", "project-1"],
          ["chat-1", "chat-1"],
        );
        assert.deepEqual(state.resolvedSessionIds, ["project-2", "project-1"]);
        assert.deepEqual(state.resolvedCakeChatSessionIds, ["chat-1"]);
      }),
    ),
  );

  itEffect("does not publish a mutation when persistence fails", () => {
    const test = makeLayer({ failSave: true });
    return Effect.gen(function* () {
      const owner = yield* ApplicationState;
      const before = yield* owner.current;
      yield* Effect.flip(setSessionUnread("session-1", true));
      const after = yield* owner.current;
      assert.deepEqual(after, before);
      assert.deepEqual(test.persisted(), before);
    }).pipe(Effect.provide(test.layer));
  });
});
