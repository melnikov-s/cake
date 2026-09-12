import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { describe } from "vitest";
import {
  forgetProjectSessions,
  mutateGlobalSessionLabels,
  mutateProjectWorkflow,
  removeProject,
  renameProject,
  setProjectSettings,
  setProjectSessionLabels,
  setProjectSessionLabelsIfUnlabelled,
  setSessionFastMode,
  setSessionUnread,
  setUtilityModel,
  setVscodeServerPath,
  touchProject,
  trustProject,
  revokeProjectTrust,
  upsertProject,
} from "../../../src/domain/application/application";
import {
  defaultApplicationState,
  SESSION_LABEL_COLORS,
} from "../../../src/domain/application/application-data";
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
  it("offers 32 curated workflow colors", () => {
    assert.equal(SESSION_LABEL_COLORS.length, 32);
    assert.equal(new Set(SESSION_LABEL_COLORS).size, 32);
  });

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
        const configured = yield* setProjectSettings("/work/cake", {
          worktreeCreateCommand: "custom-worktree {worktreeName} {worktreePath}",
          worktreeSetupCommands: "pnpm install",
          worktreeSetupInstructions: "Install dependencies only when needed.",
        });
        assert.deepEqual(configured.projects[0]?.settings, {
          worktreeCreateCommand: "custom-worktree {worktreeName} {worktreePath}",
          worktreeSetupCommands: "pnpm install",
          worktreeSetupInstructions: "Install dependencies only when needed.",
        });
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

  it.effect("deduplicates trust without limiting the number of trusted paths", () =>
    run(
      Effect.gen(function* () {
        yield* trustProject("/work/cake");
        const duplicate = yield* trustProject("/work/cake");
        assert.deepEqual(duplicate.trustedProjectPaths, ["/work/cake"]);
        for (let index = 1; index <= 200; index++) yield* trustProject(`/work/${index}`);
        const expanded = yield* trustProject("/work/beyond-the-project-registry-bound");
        assert.equal(expanded.trustedProjectPaths.length, 202);
        assert.equal(
          expanded.trustedProjectPaths.at(-1),
          "/work/beyond-the-project-registry-bound",
        );
      }),
    ),
  );

  it.effect("keeps custom workflow statuses separate and clears assignments on deletion", () =>
    run(
      Effect.gen(function* () {
        yield* upsertProject("/work/cake", "Cake");
        const labelId = "b925b5dd-9661-4f1a-9f40-406be3c96c27";
        yield* mutateProjectWorkflow("/work/cake", {
          _tag: "AddLabel",
          label: { id: labelId, name: "In progress", color: "sky" },
        });
        const secondColumnId = "bcf5bcc1-9126-4192-a0a8-eadb851c5075";
        yield* mutateProjectWorkflow("/work/cake", {
          _tag: "AddLabel",
          label: { id: secondColumnId, name: "Review", color: "violet" },
        });
        const updated = yield* mutateProjectWorkflow("/work/cake", {
          _tag: "UpdateLabel",
          labelId,
          name: "In progress now",
          color: "mint",
        });
        assert.deepEqual(
          updated.labels.find((column) => column.id === labelId),
          {
            id: labelId,
            name: "In progress now",
            color: "mint",
          },
        );
        const reordered = yield* mutateProjectWorkflow("/work/cake", {
          _tag: "MoveLabel",
          labelId,
          index: 5,
        });
        assert.deepEqual(
          reordered.labels.slice(-2).map((column) => column.id),
          [secondColumnId, labelId],
        );
        const assigned = yield* setProjectSessionLabels("/work/cake", "session-1", [
          labelId,
          secondColumnId,
        ]);
        assert.deepEqual(assigned.assignments, [
          { sessionId: "session-1", labelIds: [labelId, secondColumnId] },
        ]);
        const deleted = yield* mutateProjectWorkflow("/work/cake", {
          _tag: "DeleteLabel",
          labelId,
        });
        assert.deepEqual(deleted.labels.at(-1)?.id, secondColumnId);
        assert.deepEqual(deleted.assignments, [
          { sessionId: "session-1", labelIds: [secondColumnId] },
        ]);
      }),
    ),
  );

  it.effect("does not replace labels assigned while automatic selection was in flight", () =>
    run(
      Effect.gen(function* () {
        yield* upsertProject("/work/cake", "Cake");
        const featureId = "00000000-0000-4000-8000-000000000001";
        const bugId = "00000000-0000-4000-8000-000000000002";
        yield* setProjectSessionLabels("/work/cake", "session-1", [featureId]);
        const unchanged = yield* setProjectSessionLabelsIfUnlabelled("/work/cake", "session-1", [
          bugId,
        ]);
        assert.deepEqual(unchanged.assignments, [
          { sessionId: "session-1", labelIds: [featureId] },
        ]);
      }),
    ),
  );

  it.effect("shares global labels across Projects and clears their assignments on deletion", () =>
    run(
      Effect.gen(function* () {
        yield* upsertProject("/work/cake", "Cake");
        yield* upsertProject("/work/pi", "Pi");
        const statusId = "b925b5dd-9661-4f1a-9f40-406be3c96c27";
        const added = yield* mutateGlobalSessionLabels({
          _tag: "AddLabel",
          label: { id: statusId, name: "In review", color: "cyan" },
        });
        assert.equal(
          added.globalSessionLabels.find((status) => status.id === statusId)?.name,
          "In review",
        );
        yield* setProjectSessionLabels("/work/cake", "session-1", [statusId]);
        yield* setProjectSessionLabels("/work/pi", "session-2", [statusId]);
        const removed = yield* mutateGlobalSessionLabels({
          _tag: "DeleteLabel",
          labelId: statusId,
        });
        assert.equal(
          removed.globalSessionLabels.some((status) => status.id === statusId),
          false,
        );
        assert.deepEqual(removed.projects[0]?.workflow?.assignments, []);
        assert.deepEqual(removed.projects[1]?.workflow?.assignments, []);
      }),
    ),
  );

  it.effect("allows project labels to duplicate a global label name", () =>
    run(
      Effect.gen(function* () {
        yield* upsertProject("/work/cake", "Cake");
        const updated = yield* mutateProjectWorkflow("/work/cake", {
          _tag: "AddLabel",
          label: {
            id: "b925b5dd-9661-4f1a-9f40-406be3c96c27",
            name: "Feature",
            color: "coral",
          },
        });
        assert.equal(updated.labels[0]?.name, "Feature");
      }),
    ),
  );

  it.effect("normalizes label names while allowing duplicates and former status names", () =>
    run(
      Effect.gen(function* () {
        yield* upsertProject("/work/cake", "Cake");
        yield* mutateProjectWorkflow("/work/cake", {
          _tag: "AddLabel",
          label: {
            id: "b925b5dd-9661-4f1a-9f40-406be3c96c27",
            name: "  Waiting  ",
            color: "rose",
          },
        });
        const duplicate = yield* mutateProjectWorkflow("/work/cake", {
          _tag: "AddLabel",
          label: {
            id: "bcf5bcc1-9126-4192-a0a8-eadb851c5075",
            name: "Waiting",
            color: "amber",
          },
        });
        assert.deepEqual(
          duplicate.labels.map((label) => label.name),
          ["Waiting", "Waiting"],
        );
        const reserved = yield* mutateProjectWorkflow("/work/cake", {
          _tag: "AddLabel",
          label: {
            id: "4535dbea-37f9-4a71-a124-7eaab6a57d88",
            name: "Active",
            color: "mint",
          },
        });
        assert.equal(reserved.labels.at(-1)?.name, "Active");
        const empty = yield* Effect.flip(
          mutateProjectWorkflow("/work/cake", {
            _tag: "UpdateLabel",
            labelId: "b925b5dd-9661-4f1a-9f40-406be3c96c27",
            name: "   ",
          }),
        );
        assert.equal(empty.message, "Label names cannot be empty");
        const tooLong = yield* Effect.flip(
          mutateProjectWorkflow("/work/cake", {
            _tag: "UpdateLabel",
            labelId: "b925b5dd-9661-4f1a-9f40-406be3c96c27",
            name: "x".repeat(41),
          }),
        );
        assert.equal(tooLong.message, "Label names cannot exceed 40 characters");
      }),
    ),
  );

  it.effect("preserves unread and Fast mode forget interactions", () =>
    run(
      Effect.gen(function* () {
        yield* setSessionUnread("session-1", true);
        yield* setSessionFastMode("session-1", true);
        const forgotten = yield* forgetProjectSessions(["session-1"]);
        assert.deepEqual(forgotten.unreadSessionIds, []);
        assert.deepEqual(forgotten.fastModeSessionIds, []);
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
