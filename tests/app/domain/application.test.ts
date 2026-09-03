import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { describe } from "vitest";
import {
  forgetProjectSessions,
  removeProject,
  renameProject,
  setCakeChatSessionResolved,
  setSessionFastMode,
  setSessionUnread,
  setUtilityModel,
  setVscodeServerPath,
  touchProject,
  trustProject,
  revokeProjectTrust,
  upsertProject,
} from "../../../src/domain/application";
import { defaultApplicationState } from "../../../src/domain/application-data";
import { ApplicationState } from "../../../src/services/storage/ApplicationState";
import {
  ApplicationStorage,
  ApplicationWriteError,
} from "../../../src/services/storage/ApplicationStorage";

const makeLayer = (options?: { failSave?: boolean }) => {
  let persisted = defaultApplicationState();
  const storage = ApplicationStorage.of({
    load: Effect.fn("ApplicationStorage.Test.load")(() =>
      Effect.succeed({ state: persisted, source: "current" as const }),
    ),
    save: Effect.fn("ApplicationStorage.Test.save")(function* (state) {
      if (options?.failSave)
        return yield* new ApplicationWriteError({
          stage: "write",
          message: "injected save failure",
        });
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
  it.effect("creates, touches, renames, and removes Projects with trust revocation", () =>
    run(
      Effect.gen(function* () {
        const created = yield* upsertProject("/work/cake", "cake");
        assert.equal(created.projects.length, 1);
        const createdProject = created.projects[0];
        assert.ok(createdProject);
        const addedAt = createdProject.addedAt;
        const touched = yield* touchProject("/work/cake", "2025-01-01T00:00:00.000Z");
        assert.equal(touched.projects.length, 1);
        const touchedProject = touched.projects[0];
        assert.ok(touchedProject);
        assert.equal(touchedProject.addedAt, addedAt);
        assert.equal(touchedProject.lastOpenedAt, "2025-01-01T00:00:00.000Z");
        yield* trustProject("/work/cake");
        yield* revokeProjectTrust("/work/cake");
        yield* trustProject("/work/cake");
        const renamed = yield* renameProject("/work/cake", "  Cake desktop  ");
        assert.equal(renamed.projects[0]?.name, "Cake desktop");
        const removed = yield* removeProject("/work/cake");
        assert.deepEqual(removed.projects, []);
        assert.deepEqual(removed.trustedProjectPaths, []);
      }),
    ),
  );

  it.effect("enforces the Project registry bound", () =>
    run(
      Effect.gen(function* () {
        for (let index = 0; index < 200; index++)
          yield* upsertProject(`/project/${index}`, `Project ${index}`);
        const error = yield* Effect.flip(upsertProject("/project/overflow", "Overflow"));
        assert.equal(error._tag, "ApplicationPolicyError");
      }),
    ),
  );

  it.effect("deduplicates trust and enforces its bound", () =>
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

  it.effect("preserves unread, Cake Chat, Fast mode, and forget interactions", () =>
    run(
      Effect.gen(function* () {
        yield* setSessionUnread("session-1", true);
        yield* setCakeChatSessionResolved("cake-chat-1", true);
        yield* setSessionFastMode("session-1", true);
        const forgotten = yield* forgetProjectSessions(["session-1"]);
        assert.deepEqual(forgotten.unreadSessionIds, []);
        assert.deepEqual(forgotten.fastModeSessionIds, []);
        assert.deepEqual(forgotten.resolvedCakeChatSessionIds, ["cake-chat-1"]);
      }),
    ),
  );

  it.effect("updates Utility Model and normalizes VS Code path", () =>
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

  it.effect("does not publish a mutation when persistence fails", () => {
    const test = makeLayer({ failSave: true });
    return Effect.gen(function* () {
      const owner = yield* ApplicationState;
      const before = yield* owner.current();
      yield* Effect.flip(setSessionUnread("session-1", true));
      const after = yield* owner.current();
      assert.deepEqual(after, before);
      assert.deepEqual(test.persisted(), before);
    }).pipe(Effect.provide(test.layer));
  });
});
