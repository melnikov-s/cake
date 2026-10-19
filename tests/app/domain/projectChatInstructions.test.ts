import { it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { describe, expect } from "vitest";
import * as instructions from "../../../src/domain/projects/projectChatInstructions";
import {
  setProjectSettings,
  upsertProject,
  setCakeChatPreferences,
  setGlobalCustomInstructions,
} from "../../../src/domain/application/application";
import {
  defaultApplicationState,
  defaultProjectSettings,
} from "../../../src/contracts/application/application-data";
import { defaultCakeChatPreferences } from "../../../src/contracts/cake-chats/cake-chat-preferences";
import { ApplicationState } from "../../../src/services/storage/ApplicationState";
import { ApplicationStorage } from "../../../src/services/storage/ApplicationStorage";
import { ApplicationWriteError } from "../../../src/contracts/storage/application-storage-errors";

function fixture() {
  let persisted = defaultApplicationState();
  let failSave = false;
  const storage = Layer.succeed(
    ApplicationStorage,
    ApplicationStorage.of({
      load: () => Effect.succeed({ state: persisted, source: "current" as const }),
      save: (state) =>
        failSave
          ? Effect.fail(new ApplicationWriteError({ stage: "write", message: "Save failed" }))
          : Effect.sync(() => {
              persisted = state;
            }),
    }),
  );
  return {
    layer: ApplicationState.layer.pipe(Layer.provide(storage)),
    persisted: () => persisted,
    fail: () => {
      failSave = true;
    },
  };
}

describe("Project Chat instructions authority", () => {
  it.effect(
    "persists one registered project's text across owner restarts without touching session or shared instructions",
    () => {
      const f = fixture();
      const path = "/zombies";
      return Effect.gen(function* () {
        yield* Effect.gen(function* () {
          yield* upsertProject(path, "Zombies");
          yield* upsertProject("/other", "Other");
          yield* setProjectSettings(path, {
            ...defaultProjectSettings(),
            customInstructions: "  Session guidance.  ",
          });
          yield* setCakeChatPreferences({
            ...defaultCakeChatPreferences(),
            instructions: "Shared chat guidance.",
          });
          yield* setGlobalCustomInstructions("Global coding guidance.");
          const before = yield* instructions.get({ projectPath: path }, path);
          expect(before).toEqual({ projectPath: path, instructions: "" });
          const saved = yield* instructions.update(
            {
              projectPath: path,
              expectedInstructions: "",
              instructions: "  Project chat guidance.  ",
            },
            path,
          );
          expect(saved.instructions).toBe("  Project chat guidance.  ");
          expect(yield* instructions.get({ projectPath: path }, path)).toEqual(saved);
          expect(yield* instructions.get({ projectPath: "/other" })).toEqual({
            projectPath: "/other",
            instructions: "",
          });
          expect(
            f.persisted().projects.find((p) => p.path === path)?.settings?.customInstructions,
          ).toBe("  Session guidance.  ");
          expect(f.persisted().cakeChatPreferences?.instructions).toBe("Shared chat guidance.");
          expect(f.persisted().globalCustomInstructions).toBe("Global coding guidance.");
        }).pipe(Effect.provide(f.layer, { local: true }));
        yield* Effect.gen(function* () {
          yield* (yield* ApplicationState).initialize();
          expect((yield* instructions.get({ projectPath: path })).instructions).toBe(
            "  Project chat guidance.  ",
          );
          yield* instructions.update({
            projectPath: path,
            expectedInstructions: "  Project chat guidance.  ",
            instructions: "",
          });
          expect((yield* instructions.get({ projectPath: path })).instructions).toBe("");
        }).pipe(Effect.provide(f.layer, { local: true }));
      });
    },
  );

  it.effect(
    "rejects stale, wrong-project, worktree and unregistered writes without changing committed text",
    () => {
      const f = fixture();
      return Effect.gen(function* () {
        yield* upsertProject("/zombies", "Zombies");
        yield* upsertProject("/other", "Other");
        yield* instructions.update({
          projectPath: "/zombies",
          expectedInstructions: "",
          instructions: "Latest.",
        });
        for (const [projectPath, expectedInstructions, scope] of [
          ["/zombies", "", "/zombies"],
          ["/other", "", "/zombies"],
          ["/unregistered", "", undefined],
          ["/zombies/worktree", "", undefined],
        ] as const) {
          const result = yield* instructions
            .update(
              {
                projectPath,
                expectedInstructions,
                instructions: "Overwrite",
              },
              scope,
            )
            .pipe(Effect.flip);
          expect(result._tag).toBe("ProjectError");
        }
        expect((yield* instructions.get({ projectPath: "/zombies" })).instructions).toBe("Latest.");
        expect(
          (yield* instructions.get({ projectPath: "/other" }, "/zombies").pipe(Effect.flip))._tag,
        ).toBe("ProjectError");
      }).pipe(Effect.provide(f.layer));
    },
  );

  it.effect("does not report success or publish changed guidance when persistence fails", () => {
    const f = fixture();
    return Effect.gen(function* () {
      yield* upsertProject("/zombies", "Zombies");
      f.fail();
      const error = yield* instructions
        .update({ projectPath: "/zombies", expectedInstructions: "", instructions: "Not saved." })
        .pipe(Effect.flip);
      expect(error._tag).toBe("ApplicationWriteError");
      expect((yield* instructions.get({ projectPath: "/zombies" })).instructions).toBe("");
      expect(f.persisted().projects[0]?.settings).toBeUndefined();
    }).pipe(Effect.provide(f.layer));
  });
});
