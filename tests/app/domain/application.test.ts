import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { describe } from "vitest";
import {
  deleteSessionPlugin,
  forgetProjectSessions,
  mutateGlobalSessionLabels,
  mutateProjectWorkflow,
  removeProject,
  renameProject,
  setProjectSettings,
  setGlobalCustomInstructions,
  getCakeChatInstructions,
  setCakeChatPreferences,
  updateCakeChatInstructions,
  setExperimentalFeatures,
  setProjectSessionLabels,
  setProjectSessionLabelsIfUnlabelled,
  setSessionFastMode,
  setSessionPluginHidden,
  setSessionPluginSharedState,
  setSessionPluginState,
  patchSessionPluginState,
  setSessionUnread,
  setUtilityModel,
  setVscodeServerPath,
  touchProject,
  trustProject,
  revokeProjectTrust,
  upsertProject,
  upsertSessionPlugin,
} from "../../../src/domain/application/application";
import {
  defaultApplicationState,
  SESSION_LABEL_COLORS,
} from "../../../src/contracts/application/application-data";
import { ApplicationState } from "../../../src/services/storage/ApplicationState";
import { ApplicationStorage } from "../../../src/services/storage/ApplicationStorage";
import { ApplicationWriteError } from "../../../src/contracts/storage/application-storage-errors";

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
  it.effect(
    "keeps experiments off by default and persists the user's choice across owner restarts",
    () =>
      Effect.gen(function* () {
        const f = makeLayer();
        assert.equal(f.persisted().experimentalFeatures?.dynamicWorkflows, false);
        yield* setExperimentalFeatures({ dynamicWorkflows: true }).pipe(
          Effect.provide(f.layer, { local: true }),
        );
        assert.equal(f.persisted().experimentalFeatures?.dynamicWorkflows, true);
        const restored = yield* Effect.gen(function* () {
          const owner = yield* ApplicationState;
          yield* owner.initialize();
          return yield* owner.current();
        }).pipe(Effect.provide(f.layer, { local: true }));
        assert.equal(restored.experimentalFeatures?.dynamicWorkflows, true);
        yield* setExperimentalFeatures({ dynamicWorkflows: false }).pipe(
          Effect.provide(f.layer, { local: true }),
        );
        assert.equal(f.persisted().experimentalFeatures?.dynamicWorkflows, false);
        assert.deepEqual(f.persisted().projects, []);
      }),
  );
  it.effect("does not enable an experiment when persistence fails", () => {
    const f = makeLayer({ failSave: true });
    return Effect.gen(function* () {
      const result = yield* Effect.result(setExperimentalFeatures({ dynamicWorkflows: true }));
      assert.equal(result._tag, "Failure");
      assert.equal(
        (yield* (yield* ApplicationState).current()).experimentalFeatures?.dynamicWorkflows,
        false,
      );
      assert.equal(f.persisted().experimentalFeatures?.dynamicWorkflows, false);
    }).pipe(Effect.provide(f.layer));
  });
  it.effect("persists global personal instructions without changing project settings", () =>
    run(
      Effect.gen(function* () {
        const state = yield* setGlobalCustomInstructions("  Prefer small changes.  ");
        assert.equal(state.globalCustomInstructions, "Prefer small changes.");
        assert.deepEqual(state.projects, []);
        const cleared = yield* setGlobalCustomInstructions("");
        assert.equal(cleared.globalCustomInstructions, "");
      }),
    ),
  );

  it.effect(
    "persists Cake Chat guidance without changing other preferences and restores it",
    () => {
      const f = makeLayer();
      const instructions = "Original guidance.\n\n## Tool Gateway\nUse read-only searches.\n";
      const preferences = {
        memoryViewBytes: 8_000,
        instructions: "Original guidance.",
        summarizationModel: { source: "inherit" as const },
        // Instruction updates preserve, and reloads restore, the Subagent default model.
        subagentDefaultModel: {
          source: "model" as const,
          model: {
            provider: "p",
            modelId: "worker",
            thinkingLevel: "high" as const,
            fastMode: true,
          },
        },
      };
      return Effect.gen(function* () {
        yield* Effect.gen(function* () {
          assert.deepEqual(yield* getCakeChatInstructions(), { instructions: "" });
          yield* setCakeChatPreferences(preferences);
          yield* setGlobalCustomInstructions("Separate Project Session guidance.");
          const before = f.persisted();
          const result = yield* updateCakeChatInstructions({
            expectedInstructions: preferences.instructions,
            instructions,
          });
          assert.deepEqual(result, { instructions });
          assert.deepEqual(yield* getCakeChatInstructions(), result);
          assert.deepEqual(f.persisted(), {
            ...before,
            cakeChatPreferences: { ...preferences, instructions },
          });
        }).pipe(Effect.provide(f.layer, { local: true }));
        yield* Effect.gen(function* () {
          yield* (yield* ApplicationState).initialize();
          assert.deepEqual(yield* getCakeChatInstructions(), { instructions });
          yield* updateCakeChatInstructions({
            expectedInstructions: instructions,
            instructions: "",
          });
          assert.deepEqual(f.persisted().cakeChatPreferences, { ...preferences, instructions: "" });
        }).pipe(Effect.provide(f.layer, { local: true }));
      });
    },
  );

  it.effect("creates default Cake Chat preferences when saving guidance for the first time", () => {
    const f = makeLayer();
    return Effect.gen(function* () {
      yield* updateCakeChatInstructions({
        expectedInstructions: "",
        instructions: "Remember this.",
      });
      assert.deepEqual(f.persisted().cakeChatPreferences, {
        memoryViewBytes: 40_000,
        instructions: "Remember this.",
      });
    }).pipe(Effect.provide(f.layer));
  });

  it.effect("rejects stale or oversized Cake Chat guidance without changing saved state", () => {
    const f = makeLayer();
    return Effect.gen(function* () {
      yield* updateCakeChatInstructions({ expectedInstructions: "", instructions: "Latest." });
      const before = f.persisted();
      const conflict = yield* updateCakeChatInstructions({
        expectedInstructions: "",
        instructions: "Stale replacement.",
      }).pipe(Effect.flip);
      assert.equal(conflict._tag, "ApplicationPolicyError");
      assert.match(conflict.message, /instructions changed/);
      yield* updateCakeChatInstructions({
        expectedInstructions: "Latest.",
        instructions: "x".repeat(16_385),
      }).pipe(Effect.flip);
      assert.deepEqual(yield* getCakeChatInstructions(), { instructions: "Latest." });
      assert.deepEqual(f.persisted(), before);
    }).pipe(Effect.provide(f.layer));
  });

  it.effect("does not publish Cake Chat guidance when persistence fails", () => {
    const f = makeLayer({ failSave: true });
    return Effect.gen(function* () {
      const error = yield* updateCakeChatInstructions({
        expectedInstructions: "",
        instructions: "Unsaved.",
      }).pipe(Effect.flip);
      assert.equal(error._tag, "ApplicationWriteError");
      assert.deepEqual(yield* getCakeChatInstructions(), { instructions: "" });
      assert.equal(f.persisted().cakeChatPreferences, undefined);
    }).pipe(Effect.provide(f.layer));
  });

  it("offers 32 curated workflow colors", () => {
    assert.equal(SESSION_LABEL_COLORS.length, 32);
    assert.equal(new Set(SESSION_LABEL_COLORS).size, 32);
  });

  it.effect("persists private and shared Session Plugin state and cleans it with the session", () =>
    run(
      Effect.gen(function* () {
        const timestamp = "2026-01-01T00:00:00.000Z";
        yield* upsertSessionPlugin({
          sessionId: "session-1",
          id: "tour",
          title: "Tour",
          slot: "composer.above",
          source: "export default function Tour() { return null }",
          state: { current: 1 },
          createdAt: timestamp,
          updatedAt: timestamp,
        });
        yield* setSessionPluginState("session-1", "tour", { current: 2 });
        yield* setSessionPluginHidden("session-1", "tour", true);
        yield* upsertSessionPlugin({
          sessionId: "session-1",
          id: "tour",
          title: "Guided tour",
          slot: "composer.above",
          preset: "action-bar",
          state: {
            label: "Step two",
            actions: [{ id: "next", label: "Next", message: "Show the next step." }],
          },
          createdAt: "2026-02-01T00:00:00.000Z",
          updatedAt: "2026-02-01T00:00:00.000Z",
        });
        yield* setSessionPluginSharedState("session-1", "tour-progress", { total: 4 });
        const deleted = yield* deleteSessionPlugin("session-1", "missing");
        assert.equal(deleted.sessionPlugins[0]?.hidden, true);
        assert.equal(deleted.sessionPlugins[0]?.createdAt, timestamp);
        assert.deepEqual(deleted.sessionPlugins[0]?.state, {
          label: "Step two",
          actions: [{ id: "next", label: "Next", message: "Show the next step." }],
        });
        assert.deepEqual(deleted.sessionPluginSharedState[0]?.value, { total: 4 });

        const forgotten = yield* forgetProjectSessions(["session-1"]);
        assert.deepEqual(forgotten.sessionPlugins, []);
        assert.deepEqual(forgotten.sessionPluginSharedState, []);
      }),
    ),
  );

  it.effect(
    "atomically patches guide state without losing actions, visibility, or concurrent fields",
    () =>
      run(
        Effect.gen(function* () {
          const timestamp = "2026-01-01T00:00:00.000Z";
          const actions = [{ id: "next", label: "Continue", message: "Continue one step" }];
          yield* upsertSessionPlugin({
            sessionId: "session-1",
            id: "explanation-guide",
            title: "Guide",
            slot: "composer.above",
            preset: "action-bar",
            hidden: true,
            state: { label: "First", actions, progress: { current: 1, total: 3 } },
            createdAt: timestamp,
            updatedAt: timestamp,
          });
          yield* Effect.all(
            [
              patchSessionPluginState("session-1", "explanation-guide", { label: "Second" }),
              patchSessionPluginState("session-1", "explanation-guide", {
                progress: { current: 2, total: 3 },
              }),
            ],
            { concurrency: "unbounded" },
          );
          const owner = yield* ApplicationState;
          const plugin = (yield* owner.current()).sessionPlugins[0]!;
          assert.deepEqual(plugin.state, {
            label: "Second",
            actions,
            progress: { current: 2, total: 3 },
          });
          assert.equal(plugin.hidden, true);
          assert.equal(plugin.createdAt, timestamp);
          // A shallow nested patch cannot silently drop required progress fields.
          yield* patchSessionPluginState("session-1", "explanation-guide", {
            progress: { current: 3 },
          }).pipe(Effect.flip);
          yield* patchSessionPluginState("session-1", "explanation-guide", { actions: [] }).pipe(
            Effect.flip,
          );
          yield* patchSessionPluginState("other-session", "explanation-guide", {
            label: "Wrong owner",
          }).pipe(Effect.flip);
          assert.deepEqual((yield* owner.current()).sessionPlugins[0], plugin);
          yield* upsertSessionPlugin({
            sessionId: "session-1",
            id: "custom",
            title: "Custom",
            slot: "composer.above",
            source: "export default function X() { return null }",
            state: null,
            createdAt: timestamp,
            updatedAt: timestamp,
          });
          yield* patchSessionPluginState("session-1", "custom", {
            label: "Cannot patch null",
          }).pipe(Effect.flip);
        }),
      ),
  );

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
          projectChatInstructions: "Discuss before delegating.",
          worktreeCreateCommand: "custom-worktree {worktreeName} {worktreePath}",
          worktreeSetupCommands: "pnpm install",
          worktreeSetupInstructions: "Install dependencies only when needed.",
          worktreeRemoveCommand: "custom-remove {worktreeName}",
          worktreeCommandTimeoutSeconds: 60,
          worktreeLanding: "pull-request",
          customInstructions: "Use concise summaries.",
          icon: { mimeType: "image/png", data: "aWNvbg==" },
        });
        assert.deepEqual(configured.projects[0]?.settings, {
          projectChatInstructions: "Discuss before delegating.",
          worktreeCreateCommand: "custom-worktree {worktreeName} {worktreePath}",
          worktreeSetupCommands: "pnpm install",
          worktreeSetupInstructions: "Install dependencies only when needed.",
          worktreeRemoveCommand: "custom-remove {worktreeName}",
          worktreeCommandTimeoutSeconds: 60,
          worktreeLanding: "pull-request",
          customInstructions: "Use concise summaries.",
          icon: { mimeType: "image/png", data: "aWNvbg==" },
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
