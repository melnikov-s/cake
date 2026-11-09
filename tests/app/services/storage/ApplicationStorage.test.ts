import assert from "node:assert/strict";
import * as projectTodos from "../../../../src/domain/projects/projectTodos";
import { upsertProject, setProjectSettings } from "../../../../src/domain/application/application";
import * as application from "../../../../src/domain/application/application";
import * as settingsCatalog from "../../../../src/domain/application/settingsCatalog";
import * as modelPresets from "../../../../src/domain/model-presets/modelPresets";
import * as projectChatInstructions from "../../../../src/domain/projects/projectChatInstructions";
import {
  settingsCatalog as settingDefinitions,
  type SettingsUpdateInput,
} from "../../../../src/contracts/application/settings-catalog";
import { CakePrompts } from "../../../../src/contracts/application/cake-prompt-data";
import { PiSettings } from "../../../../src/services/pi/PiSettings";
import { CakeSessionRuntimes } from "../../../../src/services/pi/CakeSessionRuntimes";
import { it } from "@effect/vitest";
import { describe } from "vitest";
import * as autoMergeReadiness from "../../../../src/domain/worktrees/autoMergeReadiness";
import {
  WorktreeLandingCoordinator,
  WorktreeLandingCoordinatorLive,
} from "../../../../src/services/worktrees/WorktreeLandingCoordinator";
import { familyStorageHarness } from "../../helpers/familyStorageHarness";
import { SubscriptionRef, Stream } from "effect";
import { observeOperations } from "../../../../src/domain/worktrees/worktreeLandings";
import { ManagedWorktrees } from "../../../../src/services/worktrees/ManagedWorktrees";
import { Deferred, Effect, Fiber, FileSystem, Layer, Path, PlatformError, Schema } from "effect";
import {
  APPLICATION_DOCUMENT_NAME,
  ApplicationDecodeError,
  ApplicationMalformedDocumentError,
  ApplicationMigrationError,
  ApplicationStorage,
  ApplicationUnsupportedVersionError,
  makeApplicationStorageLive,
} from "../../../../src/services/storage/ApplicationStorage";
import { ApplicationWriteError } from "../../../../src/contracts/storage/application-storage-errors";
import {
  type ModelPresetPrompts,
  makeModelPresetPromptsLive,
} from "../../../../src/services/storage/ModelPresetPrompts";
import {
  defaultApplicationState,
  defaultProjectSettings,
} from "../../../../src/contracts/application/application-data";
import { browserStartupUrl } from "../../../../src/contracts/browser/browser-default-url";
import { ApplicationState } from "../../../../src/services/storage/ApplicationState";
import { defaultCakeChatPreferences } from "../../../../src/contracts/cake-chats/cake-chat-preferences";
import { updateNonChatModelPreference } from "../../../../src/domain/model-preferences/non-chat-model-preferences";
import {
  defaultCakePrompts,
  resolveCakePrompts,
} from "../../../../src/contracts/application/cake-prompt-defaults";
import { setCakePrompts } from "../../../../src/domain/application/application";
import versionFivePromptDefaults from "../../../../src/services/storage/internal/application-v5-prompt-defaults.json";

interface FakeFileSystemControls {
  readonly files: Map<string, string>;
  readonly temporaryFiles: () => ReadonlyArray<string>;
  readonly releaseWrites: Deferred.Deferred<void>;
  readonly writeStarted: Deferred.Deferred<void>;
  blockWrites: boolean;
  interruptWrite: boolean;
  failRead: boolean;
  failWrite: boolean;
  failRename: boolean;
  activeWrites: number;
  maximumActiveWrites: number;
}

const failure = (method: string) =>
  PlatformError.systemError({
    _tag: "Unknown",
    module: "TestFileSystem",
    method,
  });

const makeFakeFileSystem = Effect.fn("makeFakeFileSystem")(function* (
  initial?: Readonly<Record<string, string>>,
) {
  const controls: FakeFileSystemControls = {
    files: new Map(Object.entries(initial ?? {})),
    temporaryFiles: () => [...controls.files.keys()].filter((path) => path.endsWith(".tmp")),
    releaseWrites: yield* Deferred.make<void>(),
    writeStarted: yield* Deferred.make<void>(),
    blockWrites: false,
    interruptWrite: false,
    failRead: false,
    failWrite: false,
    failRename: false,
    activeWrites: 0,
    maximumActiveWrites: 0,
  };
  const fileSystem = FileSystem.makeNoop({
    exists: (path) => Effect.succeed(controls.files.has(path)),
    readFileString: (path) => {
      const value = controls.files.get(path);
      return controls.failRead || value === undefined
        ? Effect.fail(failure("readFileString"))
        : Effect.succeed(value);
    },
    writeFileString: (path, content) =>
      Effect.acquireUseRelease(
        Effect.sync(() => {
          controls.activeWrites += 1;
          controls.maximumActiveWrites = Math.max(
            controls.maximumActiveWrites,
            controls.activeWrites,
          );
        }),
        () => {
          if (controls.failWrite) return Effect.fail(failure("writeFileString"));
          controls.files.set(path, content);
          return Deferred.succeed(controls.writeStarted, undefined).pipe(
            Effect.andThen(
              controls.interruptWrite
                ? Effect.never
                : controls.blockWrites
                  ? Deferred.await(controls.releaseWrites)
                  : Effect.void,
            ),
          );
        },
        () =>
          Effect.sync(() => {
            controls.activeWrites -= 1;
          }),
      ),
    makeDirectory: () => Effect.void,
    chmod: () => Effect.void,
    rename: (source, target) => {
      if (controls.failRename) return Effect.fail(failure("rename"));
      const value = controls.files.get(source);
      if (value === undefined) return Effect.fail(failure("rename"));
      controls.files.set(target, value);
      controls.files.delete(source);
      return Effect.void;
    },
    remove: (path) =>
      Effect.sync(() => {
        controls.files.delete(path);
      }),
  });
  return { controls, fileSystem };
});

const expectPreference = (
  projects: { path: string; autoMergeEnabled?: boolean }[],
  path: string,
  enabled: boolean,
) => assert.equal(projects.find((project) => project.path === path)?.autoMergeEnabled, enabled);

const documentPath = `data/${APPLICATION_DOCUMENT_NAME}`;
const current = defaultApplicationState();
const legacy = {
  schemaVersion: 1,
  projects: [],
  resolvedSessionIds: ["session-1"],
  unreadSessionIds: [],
  trustedProjectPaths: [],
};

const withStorage = <A, E>(
  initial: Readonly<Record<string, string>>,
  use: (
    storage: ApplicationStorage["Service"],
    controls: FakeFileSystemControls,
  ) => Effect.Effect<A, E, ModelPresetPrompts>,
) =>
  Effect.gen(function* () {
    const fake = yield* makeFakeFileSystem(initial);
    const layer = Layer.merge(
      makeApplicationStorageLive("data", "/cake/prompts"),
      makeModelPresetPromptsLive("/cake/prompts"),
    ).pipe(
      Layer.provide(Layer.succeed(FileSystem.FileSystem)(fake.fileSystem)),
      Layer.provide(Path.layer),
    );
    return yield* Effect.gen(function* () {
      const storage = yield* ApplicationStorage;
      return yield* use(storage, fake.controls);
    }).pipe(Effect.provide(layer));
  });

describe("ApplicationStorage", () => {
  const autoMergeRuntime = (fake: {
    fileSystem: FileSystem.FileSystem;
    controls: FakeFileSystemControls;
  }) =>
    Layer.mergeAll(
      ApplicationState.layer.pipe(
        Layer.provide(
          makeApplicationStorageLive("data", "/cake/prompts").pipe(
            Layer.provide(Layer.succeed(FileSystem.FileSystem)(fake.fileSystem)),
            Layer.provide(Path.layer),
          ),
        ),
      ),
      WorktreeLandingCoordinatorLive,
      familyStorageHarness(fake.controls.files).layer,
      Layer.mock(ManagedWorktrees, { observeLandingQueue: () => Stream.succeed([]) }),
    );

  const initializeAutoMerge = Effect.gen(function* () {
    yield* (yield* ApplicationState).initialize();
    yield* autoMergeReadiness.initialize();
    return yield* SubscriptionRef.get((yield* WorktreeLandingCoordinator).state);
  });

  it.effect.each([true, false])(
    "restores Auto-merge=%s from persisted bytes in independent restarted owners; projects stay isolated",
    (enabled) =>
      Effect.gen(function* () {
        const fake = yield* makeFakeFileSystem();
        const first = yield* Effect.gen(function* () {
          yield* initializeAutoMerge;
          yield* upsertProject("/a", "A");
          yield* upsertProject("/b", "B");
          yield* autoMergeReadiness.setEnabled("/a", true);
          if (!enabled) yield* autoMergeReadiness.setEnabled("/a", false);
          yield* autoMergeReadiness.setEnabled("/b", true);
          if (enabled) yield* autoMergeReadiness.setEnabled("/b", false);
          // Settings edits must not erase the separate user-owned preference.
          yield* setProjectSettings("/a", defaultProjectSettings());
          return yield* SubscriptionRef.get((yield* WorktreeLandingCoordinator).state);
        }).pipe(Effect.provide(autoMergeRuntime(fake)));
        const document = JSON.parse(fake.controls.files.get(documentPath) ?? "{}");
        expectPreference(document.data.projects, "/a", enabled);
        expectPreference(document.data.projects, "/b", !enabled);
        const restarted = yield* initializeAutoMerge.pipe(Effect.provide(autoMergeRuntime(fake)));
        assert.equal(
          restarted.autoMergeProjects?.find((p) => p.projectPath === "/a")?.enabled,
          enabled,
        );
        assert.equal(
          restarted.autoMergeProjects?.find((p) => p.projectPath === "/b")?.enabled,
          !enabled,
        );
        assert.notEqual(restarted.autoMergeRunId, first.autoMergeRunId);
        assert.notEqual(
          restarted.autoMergeProjects?.[0]?.epoch,
          first.autoMergeProjects?.[0]?.epoch,
        );
        assert.deepEqual(restarted.autoMergeRequests ?? [], []);
      }),
  );

  it.effect.each([true, false])(
    "failed Auto-merge=%s save reports failure, leaves published/durable preference unchanged",
    (enabled) =>
      Effect.gen(function* () {
        const fake = yield* makeFakeFileSystem();
        yield* Effect.gen(function* () {
          yield* initializeAutoMerge;
          yield* upsertProject("/a", "A");
          yield* autoMergeReadiness.setEnabled("/a", !enabled);
          const before = fake.controls.files.get(documentPath);
          fake.controls.failRename = true;
          const result = yield* autoMergeReadiness.setEnabled("/a", enabled).pipe(Effect.result);
          assert.equal(result._tag, "Failure");
          if (result._tag === "Failure") assert.equal(result.failure._tag, "ApplicationWriteError");
          assert.equal(fake.controls.files.get(documentPath), before);
          const state = yield* SubscriptionRef.get((yield* WorktreeLandingCoordinator).state);
          assert.equal(
            state.autoMergeProjects?.find((p) => p.projectPath === "/a")?.enabled ?? false,
            !enabled,
          );
        }).pipe(Effect.provide(autoMergeRuntime(fake)));
        const restarted = yield* initializeAutoMerge.pipe(Effect.provide(autoMergeRuntime(fake)));
        assert.equal(
          restarted.autoMergeProjects?.find((p) => p.projectPath === "/a")?.enabled ?? false,
          !enabled,
        );
      }),
  );

  it.effect("missing and legacy project preferences stay off without startup authorization", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeFileSystem();
      const missing = yield* initializeAutoMerge.pipe(Effect.provide(autoMergeRuntime(fake)));
      assert.deepEqual(missing.autoMergeProjects, []);
      fake.controls.files.set(
        documentPath,
        JSON.stringify({
          schemaVersion: 1,
          projects: [
            {
              path: "/legacy",
              name: "Legacy",
              addedAt: "2026-01-01T00:00:00Z",
              lastOpenedAt: "2026-01-01T00:00:00Z",
            },
          ],
        }),
      );
      const restarted = yield* initializeAutoMerge.pipe(Effect.provide(autoMergeRuntime(fake)));
      assert.equal(restarted.autoMergeProjects?.[0]?.enabled, false);
      assert.equal(fake.controls.files.has("state/session-families.json"), false);
    }),
  );

  it.effect(
    "two independent window subscriptions and reconnect see committed Auto-merge preferences",
    () =>
      Effect.gen(function* () {
        const fake = yield* makeFakeFileSystem();
        yield* Effect.gen(function* () {
          yield* initializeAutoMerge;
          yield* upsertProject("/a", "A");
          const firstWindow = yield* observeOperations();
          const secondWindow = yield* observeOperations();
          const on = (stream: typeof firstWindow) =>
            stream.pipe(
              Stream.filter((state) =>
                state.autoMergeProjects.some((p) => p.projectPath === "/a" && p.enabled),
              ),
              Stream.take(1),
              Stream.runCollect,
            );
          const first = yield* on(firstWindow).pipe(Effect.forkChild);
          const second = yield* on(secondWindow).pipe(Effect.forkChild);
          yield* autoMergeReadiness.setEnabled("/a", true);
          assert.deepEqual(yield* Fiber.join(first), yield* Fiber.join(second));
          const reconnected = yield* (yield* observeOperations()).pipe(
            Stream.take(1),
            Stream.runCollect,
          );
          assert.equal(reconnected[0]?.autoMergeProjects[0]?.enabled, true);
        }).pipe(Effect.provide(autoMergeRuntime(fake)));
      }),
  );
  it.effect(
    "persists per-project browser startup URLs across fresh owners and clearing restores Google",
    () =>
      withStorage({}, (storage) => {
        const owner = ApplicationState.layer.pipe(
          Layer.provide(Layer.succeed(ApplicationStorage)(storage)),
        );
        const readAfterRestart = Effect.gen(function* () {
          const application = yield* ApplicationState;
          yield* application.initialize();
          return (yield* application.current()).projects;
        });
        return Effect.gen(function* () {
          yield* Effect.gen(function* () {
            yield* upsertProject("/one", "One");
            yield* upsertProject("/two", "Two");
            yield* upsertProject("/unset", "Unset");
            yield* setProjectSettings("/one", {
              ...defaultProjectSettings(),
              browserDefaultUrl: "https://one.example/start",
            });
            yield* setProjectSettings("/two", {
              ...defaultProjectSettings(),
              browserDefaultUrl: "http://localhost:5173/",
            });
          }).pipe(Effect.provide(owner, { local: true }));
          const restored = yield* readAfterRestart.pipe(Effect.provide(owner, { local: true }));
          assert.equal(
            restored.find((p) => p.path === "/one")?.settings?.browserDefaultUrl,
            "https://one.example/start",
          );
          assert.equal(
            restored.find((p) => p.path === "/two")?.settings?.browserDefaultUrl,
            "http://localhost:5173/",
          );
          assert.equal(
            browserStartupUrl(
              restored.find((p) => p.path === "/unset")?.settings?.browserDefaultUrl,
            ),
            "https://www.google.com/",
          );
          yield* Effect.gen(function* () {
            yield* (yield* ApplicationState).initialize();
            yield* setProjectSettings("/one", {
              ...defaultProjectSettings(),
              browserDefaultUrl: "",
            });
          }).pipe(Effect.provide(owner, { local: true }));
          const cleared = yield* readAfterRestart.pipe(Effect.provide(owner, { local: true }));
          assert.equal(cleared.find((p) => p.path === "/one")?.settings?.browserDefaultUrl, "");
          assert.equal(
            browserStartupUrl(cleared.find((p) => p.path === "/one")?.settings?.browserDefaultUrl),
            "https://www.google.com/",
          );
          assert.equal(
            cleared.find((p) => p.path === "/two")?.settings?.browserDefaultUrl,
            "http://localhost:5173/",
          );
        });
      }),
  );

  it.effect(
    "round-trips every application catalog setting and dedicated Project, preset, label and instruction settings through fresh owners",
    () =>
      withStorage({}, (storage) => {
        const owner = ApplicationState.layer.pipe(
          Layer.provide(Layer.succeed(ApplicationStorage)(storage)),
        );
        return Effect.gen(function* () {
          const committed = yield* Effect.gen(function* () {
            const state = yield* ApplicationState;
            yield* state.initialize();
            yield* application.upsertProject("/project", "Project");
            yield* application.setProjectSettings("/project", {
              worktreeCreateCommand: "git worktree add {worktreePath}",
              worktreeSetupCommands: "pnpm install\npnpm build:slim",
              worktreeSetupInstructions: "Keep dependencies isolated.",
              worktreeRemoveCommand: "tree remove {worktreeName}",
              worktreeCommandTimeoutSeconds: 120,
              worktreeLanding: "pull-request",
              customInstructions: "Coding session guidance.",
              projectChatInstructions: "Project Chat guidance.",
              icon: { mimeType: "image/png", data: "aWNvbg==" },
            });
            yield* projectChatInstructions.update({
              projectPath: "/project",
              expectedInstructions: "Project Chat guidance.",
              instructions: "Updated Project Chat guidance.",
            });
            yield* application.updateCakeChatInstructions({
              expectedInstructions: "",
              instructions: "Shared Cake Chat guidance.",
            });
            yield* application.setVscodeServerPath("/custom/code-server");
            const presets = yield* modelPresets.create({
              name: "Persisted model",
              prompt: "Keep the preset-specific guidance across restart.",
              provider: "example",
              modelId: "example-model",
              thinkingLevel: "high",
              fastMode: true,
            });
            const preset = presets.presets[0];
            assert.ok(preset);
            const updates: SettingsUpdateInput[] = [
              { key: "appearance.leftToolbar.autoHide", value: true },
              { key: "appearance.leftToolbar.layout", value: "slim" },
              { key: "cakeChat.contextLimitTokens", value: 128_000 },
              { key: "cakeChat.memoryViewBytes", value: 20_000 },
              { key: "companion.contextLimitTokens", value: 64_000 },
              { key: "companion.memoryViewBytes", value: 5_000 },
              { key: "companion.instructions", value: "Companion guidance only." },
              {
                key: "cakeChat.summarizationModel",
                value: { source: "preset", presetId: preset.id },
              },
              {
                key: "cakeChat.subagentDefaultModel",
                value: {
                  source: "model",
                  model: {
                    provider: "example",
                    modelId: "subagent",
                    thinkingLevel: "low",
                    fastMode: true,
                  },
                },
              },
              { key: "models.defaultPreset", value: preset.id },
              {
                key: "models.utility",
                value: { provider: "example", modelId: "utility", thinkingLevel: "low" },
              },
              { key: "models.imagePreference", value: { provider: "example", modelId: "image" } },
              {
                key: "models.classifierPreference",
                value: { provider: "example", modelId: "classifier" },
              },
              { key: "instructions.global", value: "Global coding guidance." },
              ...Object.keys(CakePrompts.fields).map((key) => ({
                key: `prompts.${key}`,
                value: `Custom ${key} prompt.`,
              })),
            ];
            // Fail when a future catalog control has no restart-persistence case.
            assert.deepEqual(
              updates.map(({ key }) => key).sort(),
              settingDefinitions
                .filter(({ key }) => !key.startsWith("pi."))
                .map(({ key }) => key)
                .sort(),
            );
            for (const input of updates) {
              const updated = yield* settingsCatalog.update(input);
              assert.deepEqual(updated.value, input.value, input.key);
            }
            yield* application.mutateGlobalSessionLabels({
              _tag: "AddLabel",
              label: { id: "00000000-0000-4000-8000-000000000099", name: "Custom", color: "green" },
            });
            yield* application.mutateProjectWorkflow("/project", {
              _tag: "AddLabel",
              label: { id: "00000000-0000-4000-8000-000000000098", name: "Project", color: "blue" },
            });
            yield* application.setProjectSessionLabels("/project", "session", [
              "00000000-0000-4000-8000-000000000099",
              "00000000-0000-4000-8000-000000000098",
            ]);
            return yield* state.current();
          }).pipe(
            Effect.provide(owner, { local: true }),
            // Application catalog writes must not acquire Pi or conversation runtimes.
            Effect.provide(
              Layer.merge(Layer.mock(PiSettings, {}), Layer.mock(CakeSessionRuntimes, {})),
            ),
          );
          assert.deepEqual((yield* storage.load()).state, committed);
          yield* Effect.gen(function* () {
            const state = yield* ApplicationState;
            yield* state.initialize();
            assert.deepEqual(yield* state.current(), committed);
          }).pipe(Effect.provide(owner, { local: true }));
        });
      }),
  );

  it.effect(
    "persists independent backend non-chat preferences, reloads references and leaves chat configuration unchanged",
    () =>
      withStorage({}, (storage) =>
        Effect.gen(function* () {
          const application = yield* ApplicationState;
          yield* application.initialize();
          const image = { provider: "openrouter", modelId: "image" };
          const classifier = { provider: "typesafe", modelId: "jev-latest" };
          yield* updateNonChatModelPreference({ type: "image", preference: image });
          yield* updateNonChatModelPreference({ type: "classifier", preference: classifier });
          const loaded = (yield* storage.load()).state;
          assert.deepEqual(loaded.nonChatModelPreferences, { image, classifier });
          assert.deepEqual(loaded.modelPresets, []);
          assert.equal(loaded.utilityModel, undefined);
          yield* updateNonChatModelPreference({ type: "image", preference: null });
          assert.deepEqual((yield* storage.load()).state.nonChatModelPreferences, { classifier });
          yield* updateNonChatModelPreference({ type: "classifier", preference: null });
          assert.deepEqual((yield* storage.load()).state.nonChatModelPreferences, {});
        }).pipe(
          Effect.provide(
            ApplicationState.layer.pipe(Layer.provide(Layer.succeed(ApplicationStorage)(storage))),
          ),
        ),
      ),
  );

  it.effect("uses explicit defaults for a missing file", () =>
    withStorage({}, (storage) =>
      Effect.gen(function* () {
        const loaded = yield* storage.load();
        assert.strictEqual(loaded.source, "missing");
        assert.deepStrictEqual(loaded.state, current);
      }),
    ),
  );

  it.effect("returns a typed read failure", () =>
    withStorage({ [documentPath]: "unreadable" }, (storage, controls) =>
      Effect.gen(function* () {
        controls.failRead = true;
        const error = yield* Effect.flip(storage.load());
        assert.equal(error._tag, "ApplicationReadError");
      }),
    ),
  );

  it.effect("loads a current version envelope", () =>
    withStorage({ [documentPath]: JSON.stringify({ version: 11, data: current }) }, (storage) =>
      Effect.gen(function* () {
        const loaded = yield* storage.load();
        assert.strictEqual(loaded.source, "current");
        assert.deepStrictEqual(loaded.state, current);
      }),
    ),
  );

  it.effect("loads a current document that still lists retired Project trust", () =>
    withStorage(
      {
        [documentPath]: JSON.stringify({
          version: 11,
          data: { ...current, trustedProjectPaths: ["/work/cake"] },
        }),
      },
      (storage) =>
        Effect.gen(function* () {
          const loaded = yield* storage.load();
          assert.strictEqual(loaded.source, "current");
          assert.deepStrictEqual(loaded.state, current);
        }),
    ),
  );

  it.effect("defaults personal instructions in existing application and project settings", () =>
    withStorage(
      {
        [documentPath]: JSON.stringify({
          version: 11,
          data: {
            ...current,
            globalCustomInstructions: undefined,
            projects: [
              {
                path: "/work/cake",
                name: "Cake",
                addedAt: "2026-01-01T00:00:00.000Z",
                lastOpenedAt: "2026-01-01T00:00:00.000Z",
                settings: {
                  worktreeCreateCommand:
                    "git worktree add -b {branchName} {worktreePath} {baseCommit}",
                  worktreeSetupCommands: "pnpm install",
                },
              },
            ],
          },
        }),
      },
      (storage) =>
        Effect.gen(function* () {
          const loaded = yield* storage.load();
          assert.strictEqual(loaded.source, "current");
          assert.equal(loaded.state.projects[0]?.settings?.worktreeSetupInstructions, "");
          assert.equal(loaded.state.projects[0]?.settings?.customInstructions, "");
          assert.equal(loaded.state.projects[0]?.settings?.projectChatInstructions, "");
          assert.equal(loaded.state.projects[0]?.settings?.worktreeRemoveCommand, "");
          assert.equal(loaded.state.projects[0]?.settings?.worktreeCommandTimeoutSeconds, 0);
          assert.equal(loaded.state.projects[0]?.settings?.worktreeLanding, "merge");
          assert.equal(loaded.state.globalCustomInstructions, "");
        }),
    ),
  );

  it.effect("replaces only the version-nine default worktree creation command", () =>
    withStorage(
      {
        [documentPath]: JSON.stringify({
          version: 9,
          data: {
            ...current,
            projects: ["default", "custom"].map((name) => ({
              path: `/work/${name}`,
              name,
              addedAt: "2026-01-01T00:00:00.000Z",
              lastOpenedAt: "2026-01-01T00:00:00.000Z",
              settings: {
                worktreeCreateCommand:
                  name === "default"
                    ? "git worktree add -b {branchName} {worktreePath} {baseCommit}"
                    : "my-tree add {worktreeName}",
                worktreeSetupCommands: "pnpm install",
              },
            })),
          },
        }),
      },
      (storage) =>
        Effect.gen(function* () {
          const loaded = yield* storage.load();
          assert.strictEqual(loaded.source, "migrated");
          assert.deepEqual(
            loaded.state.projects.map((project) => project.settings?.worktreeCreateCommand),
            ["", "my-tree add {worktreeName}"],
          );
          assert.equal(loaded.state.projects[0]?.settings?.worktreeSetupCommands, "pnpm install");
        }),
    ),
  );

  it.effect("preserves old session guidance without inferring Project Chat intent", () =>
    withStorage(
      {
        [documentPath]: JSON.stringify({
          version: 7,
          data: {
            ...current,
            projects: [
              {
                path: "/work/zombies",
                name: "Zombies",
                addedAt: "2026-01-01T00:00:00.000Z",
                lastOpenedAt: "2026-01-01T00:00:00.000Z",
                settings: {
                  worktreeCreateCommand: "git worktree add {worktreePath}",
                  worktreeSetupCommands: "",
                  customInstructions: "  Keep my exact session guidance.\n",
                },
              },
            ],
          },
        }),
      },
      (storage) =>
        Effect.gen(function* () {
          const loaded = yield* storage.load();
          assert.equal(
            loaded.state.projects[0]?.settings?.customInstructions,
            "  Keep my exact session guidance.\n",
          );
          assert.equal(loaded.state.projects[0]?.settings?.projectChatInstructions, "");
          yield* storage.save(loaded.state);
          const reloaded = yield* storage.load();
          assert.deepEqual(reloaded.state.projects, loaded.state.projects);
        }),
    ),
  );

  it.effect(
    "roundtrips distinct instructions for each registered project through application storage",
    () =>
      withStorage({}, (storage) =>
        Effect.gen(function* () {
          const projects = ["/zombies", "/other"].map((path) => ({
            path,
            name: path.slice(1),
            addedAt: "2026-01-01T00:00:00.000Z",
            lastOpenedAt: "2026-01-01T00:00:00.000Z",
            settings: {
              ...defaultProjectSettings(),
              worktreeCreateCommand: "git worktree add {worktreePath}",
              customInstructions: path + " coding only.",
              projectChatInstructions: "  " + path + " permanent chat only.  ",
            },
          }));
          yield* storage.save({ ...current, projects });
          const loaded = yield* storage.load();
          assert.deepEqual(loaded.state.projects, projects);
        }),
      ),
  );

  it.effect("uses unset Cake prompts when migrating a version-four document", () => {
    const versionFour = { ...current, trustedProjectPaths: [] };
    Reflect.deleteProperty(versionFour, "cakePrompts");
    return withStorage(
      { [documentPath]: JSON.stringify({ version: 4, data: versionFour }) },
      (storage) =>
        Effect.gen(function* () {
          const loaded = yield* storage.load();
          assert.strictEqual(loaded.source, "migrated");
          assert.deepEqual(loaded.state.cakePrompts, {});
          assert.equal(
            resolveCakePrompts(loaded.state.cakePrompts).worktreeCommit,
            "Commit this change.",
          );
        }),
    );
  });

  it.effect("removes copied defaults from version five while preserving custom prompts", () =>
    Effect.gen(function* () {
      const oldCommitDefault =
        "Cake is preparing to merge this worktree into {{target}}, but it has uncommitted changes.\n\nInspect the complete working tree, verify the change, and commit all intended work with an appropriate commit message.\n\nDo not merge, rebase, push, switch branches, or modify the target checkout. Cake will merge the committed branch after this turn finishes.";
      for (const worktreeCommit of [
        oldCommitDefault,
        versionFivePromptDefaults.worktreeCommit,
        "Custom commit wording",
      ]) {
        yield* withStorage(
          {
            [documentPath]: JSON.stringify({
              version: 5,
              data: {
                ...current,
                cakePrompts: {
                  ...versionFivePromptDefaults,
                  worktreeCommit,
                  worktreeSquashMessage: "Custom squash wording",
                },
              },
            }),
          },
          (storage, controls) =>
            Effect.gen(function* () {
              const loaded = yield* storage.load();
              const expected = {
                ...(worktreeCommit === "Custom commit wording" ? { worktreeCommit } : {}),
                worktreeSquashMessage: "Custom squash wording",
              };
              assert.equal(loaded.source, "migrated");
              assert.deepEqual(loaded.state.cakePrompts, expected);
              const persistedText = controls.files.get(documentPath);
              assert.ok(persistedText);
              assert.deepEqual(JSON.parse(persistedText).data.cakePrompts, expected);
              assert.equal((yield* storage.load()).source, "current");
            }),
        );
      }
    }),
  );

  it.effect(
    "restores the raised saved memory default once while preserving custom budgets and unrelated preferences",
    () =>
      Effect.gen(function* () {
        for (const memoryViewBytes of [undefined, 5_000, 20_000, 40_000, 80_000, 128_000]) {
          const preferences =
            memoryViewBytes === undefined
              ? undefined
              : {
                  memoryViewBytes,
                  instructions: "Keep this guidance",
                  contextLimitTokens: 300_000,
                  summarizationModel: { source: "utility" as const },
                  subagentDefaultModel: { source: "inherit" as const },
                };
          const before = {
            ...current,
            globalCustomInstructions: "Keep global guidance",
            cakePrompts: { worktreeCommit: "Custom commit guidance" },
            ...(preferences ? { cakeChatPreferences: preferences } : {}),
          };
          const expected = preferences
            ? {
                ...before,
                cakeChatPreferences: {
                  ...preferences,
                  memoryViewBytes: memoryViewBytes === 128_000 ? 40_000 : memoryViewBytes,
                },
              }
            : before;
          yield* withStorage(
            { [documentPath]: JSON.stringify({ version: 7, data: before }) },
            (storage, controls) =>
              Effect.gen(function* () {
                const loaded = yield* storage.load();
                assert.equal(loaded.source, "migrated");
                assert.deepEqual(loaded.state, expected);
                assert.equal(
                  (loaded.state.cakeChatPreferences ?? defaultCakeChatPreferences())
                    .memoryViewBytes,
                  memoryViewBytes === undefined || memoryViewBytes === 128_000
                    ? 40_000
                    : memoryViewBytes,
                );
                const persisted = controls.files.get(documentPath);
                assert.ok(persisted);
                assert.deepEqual(JSON.parse(persisted), { version: 11, data: expected });
                assert.deepEqual(yield* storage.load(), { source: "current", state: expected });

                // An explicit choice after the one-time transition must not be remapped.
                const customized = {
                  ...loaded.state,
                  cakeChatPreferences: {
                    ...defaultCakeChatPreferences(),
                    ...preferences,
                    memoryViewBytes: 128_000,
                  },
                };
                yield* storage.save(customized);
                assert.deepEqual(yield* storage.load(), { source: "current", state: customized });
              }),
          );
        }
      }),
  );

  it.effect("migrates a version-six summarization model to an explicit model choice", () =>
    Effect.gen(function* () {
      const legacy = { provider: "p", modelId: "summary", thinkingLevel: "low" };
      for (const [summarizationModel, expected] of [
        [legacy, { source: "model", model: { ...legacy, fastMode: false } }],
        [undefined, undefined],
      ] as const) {
        const preferences = { memoryViewBytes: 8_000, instructions: "Guidance" };
        yield* withStorage(
          {
            [documentPath]: JSON.stringify({
              version: 6,
              data: {
                ...current,
                cakeChatPreferences: summarizationModel
                  ? { ...preferences, summarizationModel }
                  : preferences,
              },
            }),
          },
          (storage, controls) =>
            Effect.gen(function* () {
              const loaded = yield* storage.load();
              assert.equal(loaded.source, "migrated");
              assert.deepEqual(
                loaded.state.cakeChatPreferences,
                expected ? { ...preferences, summarizationModel: expected } : preferences,
              );
              const persistedText = controls.files.get(documentPath);
              assert.ok(persistedText);
              assert.equal(JSON.parse(persistedText).version, 11);
              assert.equal((yield* storage.load()).source, "current");
            }),
        );
      }
    }),
  );

  it.effect("preserves explicit current-version text and lets domain policy resolve it", () =>
    withStorage(
      {
        [documentPath]: JSON.stringify({
          version: 11,
          data: {
            ...current,
            cakePrompts: {
              worktreeCommit: versionFivePromptDefaults.worktreeCommit,
              dictationCleanup: "Custom cleanup guidance",
            },
          },
        }),
      },
      (storage) =>
        Effect.gen(function* () {
          const loaded = yield* storage.load();
          assert.equal(loaded.source, "current");
          // Historical default removal belongs only to the v5 migration, not current storage.
          assert.deepEqual(loaded.state.cakePrompts, {
            worktreeCommit: versionFivePromptDefaults.worktreeCommit,
            dictationCleanup: "Custom cleanup guidance",
          });
          assert.equal(
            resolveCakePrompts(loaded.state.cakePrompts).dictationCleanup,
            "Custom cleanup guidance",
          );
        }),
    ),
  );

  it.effect("persists only custom overrides and resolves defaults after reset and reload", () =>
    withStorage({}, (storage, controls) =>
      Effect.gen(function* () {
        const application = yield* ApplicationState;
        yield* application.initialize();
        yield* setCakePrompts({ worktreeCommit: "Custom commit wording" });
        assert.deepEqual((yield* storage.load()).state.cakePrompts, {
          worktreeCommit: "Custom commit wording",
        });
        yield* setCakePrompts({
          worktreeCommit: "",
          worktreeSquashMessage: defaultCakePrompts().worktreeSquashMessage,
        });
        const loaded = yield* storage.load();
        assert.deepEqual(loaded.state.cakePrompts, {});
        const persistedText = controls.files.get(documentPath);
        assert.ok(persistedText);
        assert.deepEqual(JSON.parse(persistedText).data.cakePrompts, {});
        assert.deepEqual(resolveCakePrompts(loaded.state.cakePrompts), defaultCakePrompts());
      }).pipe(
        Effect.provide(
          ApplicationState.layer.pipe(Layer.provide(Layer.succeed(ApplicationStorage)(storage))),
        ),
      ),
    ),
  );

  it.effect(
    "round-trips Project Chat to-dos and undelivered user changes, and clears the panel-scoped selection on restart",
    () =>
      withStorage({}, (storage) => {
        const owner = ApplicationState.layer.pipe(
          Layer.provide(Layer.succeed(ApplicationStorage)(storage)),
        );
        return Effect.gen(function* () {
          const created = yield* Effect.gen(function* () {
            yield* (yield* ApplicationState).initialize();
            yield* upsertProject("/project", "Project");
            const item = yield* projectTodos.create("/project", {
              title: "Follow up",
              description: "Follow up.",
              status: "Report delivered; awaiting your review",
            });
            yield* projectTodos.mutateUser("/project", { _tag: "Select", selectedId: item.id });
            return item;
          }).pipe(Effect.provide(owner, { local: true }));
          yield* Effect.gen(function* () {
            yield* (yield* ApplicationState).initialize();
            const recovered = yield* projectTodos.list("/project");
            assert.deepEqual(recovered.items, [created]);
            // No to-do panel is open at startup; view focus clears without a reminder.
            assert.equal(recovered.selectedId, null);
            assert.deepEqual(recovered.pending, []);
          }).pipe(Effect.provide(owner, { local: true }));
        });
      }),
  );

  it.effect(
    "preserves an explicitly cleared selection across owner recreation and repeated storage reload with other open items",
    () =>
      withStorage({}, (storage) => {
        const owner = ApplicationState.layer.pipe(
          Layer.provide(Layer.succeed(ApplicationStorage)(storage)),
        );
        return Effect.gen(function* () {
          const cleared = yield* Effect.gen(function* () {
            yield* (yield* ApplicationState).initialize();
            yield* upsertProject("/project", "Project");
            const first = yield* projectTodos.create("/project", {
              title: "First",
              description: "Open work.",
            });
            yield* projectTodos.create("/project", { title: "Second", description: "Also open." });
            yield* projectTodos.mutateUser("/project", { _tag: "Select", selectedId: first.id });
            return yield* projectTodos.mutateUser("/project", { _tag: "Select", selectedId: null });
          }).pipe(Effect.provide(owner, { local: true }));
          assert.equal(cleared.selectedId, null);
          yield* Effect.gen(function* () {
            yield* (yield* ApplicationState).initialize();
            assert.deepEqual(yield* projectTodos.list("/project"), cleared);
          }).pipe(Effect.provide(owner, { local: true }));
          assert.deepEqual((yield* storage.load()).state.projects[0]?.todos, cleared);
          assert.deepEqual((yield* storage.load()).state.projects[0]?.todos, cleared);
        });
      }),
  );

  it.effect(
    "repairs a current-version persisted done selection before publication and durably keeps it cleared on reload",
    () =>
      withStorage({}, (storage, controls) => {
        const id = "00000000-0000-4000-8000-000000000011";
        const token = "00000000-0000-4000-8000-000000000012";
        const todos = {
          items: [
            {
              id,
              title: "Completed work",
              description: "Original brief.",
              status: "Finished",
              state: "done",
              revision: 2,
              associations: [],
            },
          ],
          selectedId: id,
          sequence: 4,
          deliveryToken: token,
          pending: [{ _tag: "Selection", sequence: 4, selectedId: id }],
        };
        controls.files.set(
          documentPath,
          JSON.stringify({
            version: 11,
            data: {
              ...current,
              projects: [
                {
                  path: "/project",
                  name: "Project",
                  addedAt: "2026-01-01T00:00:00Z",
                  lastOpenedAt: "2026-01-01T00:00:00Z",
                  todos,
                },
              ],
            },
          }),
        );
        return Effect.gen(function* () {
          const loaded = yield* storage.load();
          const repaired = loaded.state.projects[0]?.todos;
          assert.equal(repaired?.selectedId, null);
          assert.equal(repaired?.sequence, 4);
          assert.equal(repaired?.deliveryToken, null);
          assert.deepEqual(repaired?.items, todos.items);
          assert.deepEqual(repaired?.pending, []);
          assert.deepEqual(
            JSON.parse(controls.files.get(documentPath) ?? "{}").data.projects[0].todos,
            repaired,
          );
          assert.deepEqual((yield* storage.load()).state.projects[0]?.todos, repaired);
        });
      }),
  );

  it.effect(
    "migrates v8 to-do descriptions and repairs a completed selection without losing progress or links",
    () => {
      const id = "00000000-0000-4000-8000-000000000011";
      const token = "00000000-0000-4000-8000-000000000012";
      const items = [
        {
          id,
          title: "Startup",
          status: "Report delivered; awaiting review",
          state: "done",
          revision: 3,
          associations: [{ kind: "session", sessionId: "worker", title: "Worker" }],
        },
        {
          id: "00000000-0000-4000-8000-000000000013",
          title: "Discuss next steps",
          status: "",
          state: "open",
          revision: 0,
          associations: [],
        },
      ];
      const todos = {
        items,
        selectedId: id,
        sequence: 2,
        deliveryToken: token,
        pending: [{ _tag: "Selection", sequence: 2, selectedId: id }],
      };
      return withStorage(
        {
          [documentPath]: JSON.stringify({
            version: 8,
            data: {
              ...current,
              projects: [
                {
                  path: "/project",
                  name: "Project",
                  addedAt: "2026-01-01T00:00:00Z",
                  lastOpenedAt: "2026-01-01T00:00:00Z",
                  todos,
                },
              ],
            },
          }),
        },
        (storage, controls) =>
          Effect.gen(function* () {
            const loaded = yield* storage.load();
            assert.equal(loaded.source, "migrated");
            const expected = {
              ...todos,
              items: items.map((item) => ({ ...item, description: item.status || item.title })),
            };
            const recovered = loaded.state.projects[0]?.todos;
            assert.deepEqual(recovered?.items, expected.items);
            assert.equal(recovered?.selectedId, null);
            assert.equal(recovered?.sequence, 2);
            assert.equal(recovered?.deliveryToken, null);
            assert.deepEqual(recovered?.pending, []);
            assert.equal(JSON.parse(controls.files.get(documentPath) ?? "{}").version, 11);
            assert.deepEqual((yield* storage.load()).state.projects[0]?.todos, recovered);
          }),
      );
    },
  );

  it.effect("migrates recognized legacy and version-zero documents", () =>
    Effect.gen(function* () {
      for (const input of [legacy, { version: 0, data: legacy }]) {
        yield* withStorage({ [documentPath]: JSON.stringify(input) }, (storage, controls) =>
          Effect.gen(function* () {
            const loaded = yield* storage.load();
            assert.strictEqual(loaded.source, "migrated");
            assert.ok(!("resolvedSessionIds" in loaded.state));
            const persistedText = controls.files.get(documentPath);
            assert.ok(persistedText);
            const persisted = JSON.parse(persistedText);
            assert.strictEqual(persisted.version, 11);
            assert.ok(!("schemaVersion" in persisted.data));
          }),
        );
      }
    }),
  );

  it.effect("migrates project defaults into the global status catalog", () => {
    const featureId = "00000000-0000-4000-8000-000000000001";
    const versionOne = {
      projects: [
        {
          path: "/work/cake",
          name: "Cake",
          addedAt: "2026-01-01T00:00:00.000Z",
          lastOpenedAt: "2026-01-01T00:00:00.000Z",
          workflow: {
            columns: [
              { id: featureId, name: "Feature", color: "blue" },
              {
                id: "b925b5dd-9661-4f1a-9f40-406be3c96c27",
                name: "In review",
                color: "cyan",
              },
            ],
            assignments: [{ sessionId: "session-1", statusId: featureId }],
            sessionDetails: [],
          },
        },
      ],
      unreadSessionIds: [],
      trustedProjectPaths: [],
      fastModeSessionIds: [],
      modelPresets: [],
    };
    return withStorage(
      { [documentPath]: JSON.stringify({ version: 1, data: versionOne }) },
      (storage) =>
        Effect.gen(function* () {
          const loaded = yield* storage.load();
          assert.strictEqual(loaded.source, "migrated");
          assert.equal(loaded.state.globalSessionLabels[0]?.name, "Feature");
          assert.deepEqual(
            loaded.state.projects[0]?.workflow?.labels.map((status) => status.name),
            ["In review"],
          );
          assert.deepEqual(loaded.state.projects[0]?.workflow?.assignments, [
            { sessionId: "session-1", labelIds: [featureId] },
          ]);
        }),
    );
  });

  it.effect(
    "migrates inline preset prompts exactly and rereads no inline copy after restart",
    () => {
      const contents = ["  # Review\r\n\r\nUnicode: café 🎂\n  ", "", " \t\r\n"];
      const modelPresets = [...contents, undefined].map((prompt, index) => ({
        id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        name: `Preset ${index}`,
        provider: "example",
        modelId: "same-model",
        thinkingLevel: "off",
        fastMode: false,
        ...(prompt === undefined ? null : { prompt }),
      }));
      return withStorage(
        { [documentPath]: JSON.stringify({ version: 10, data: { ...current, modelPresets } }) },
        (storage, controls) =>
          Effect.gen(function* () {
            const loaded = yield* storage.load();
            assert.equal(loaded.source, "migrated");
            const references = loaded.state.modelPresets.map((preset) => preset.promptFile);
            assert.equal(new Set(references).size, 4);
            for (const [index, prompt] of contents.entries()) {
              const reference = references[index];
              assert.ok(reference);
              assert.ok(reference.startsWith("/cake/prompts/"));
              assert.equal(controls.files.get(reference), prompt);
            }
            assert.equal(references[3], undefined);
            const persisted = JSON.parse(controls.files.get(documentPath) ?? "{}");
            assert.equal(persisted.version, 11);
            assert.deepEqual(persisted.data.modelPresets, loaded.state.modelPresets);
            const firstReference = references[0];
            assert.ok(firstReference);
            controls.files.set(firstReference, "Edited externally.");
            const restarted = yield* storage.load();
            assert.equal(restarted.source, "current");
            assert.deepEqual(restarted.state.modelPresets, loaded.state.modelPresets);
            assert.equal(controls.files.get(firstReference), "Edited externally.");
          }),
      );
    },
  );

  it.effect("keeps inline originals when a preset prompt migration write fails", () => {
    const original = JSON.stringify({
      version: 10,
      data: {
        ...current,
        modelPresets: [
          {
            id: "00000000-0000-4000-8000-000000000001",
            name: "Review",
            provider: "example",
            modelId: "model",
            thinkingLevel: "off",
            fastMode: false,
            prompt: "Exact original.\r\n",
          },
        ],
      },
    });
    return withStorage({ [documentPath]: original }, (storage, controls) =>
      Effect.gen(function* () {
        controls.failWrite = true;
        const error = yield* Effect.flip(storage.load());
        assert.ok(Schema.is(ApplicationMigrationError)(error));
        assert.match(error.message, /Could not write preset prompt \/cake\/prompts\//);
        assert.equal(controls.files.get(documentPath), original);
        assert.deepEqual(controls.temporaryFiles(), []);
      }),
    );
  });

  it.effect("returns typed failures for malformed, future, and invalid documents", () =>
    Effect.gen(function* () {
      const cases = [
        ["{", ApplicationMalformedDocumentError],
        [JSON.stringify({ nope: true }), ApplicationMalformedDocumentError],
        [
          JSON.stringify({ version: 11, data: { ...current, projects: "invalid" } }),
          ApplicationDecodeError,
        ],
        [JSON.stringify({ version: 12, data: current }), ApplicationUnsupportedVersionError],
        [
          JSON.stringify({ version: 0, data: { schemaVersion: 1, projects: "invalid" } }),
          ApplicationMigrationError,
        ],
      ] as const;
      for (const [content, ErrorSchema] of cases) {
        yield* withStorage({ [documentPath]: content }, (storage) =>
          Effect.gen(function* () {
            const error = yield* Effect.flip(storage.load());
            assert.ok(Schema.is(ErrorSchema)(error));
          }),
        );
      }
    }),
  );

  it.effect(
    "keeps the previous file and cleans temporary files after write and rename failure",
    () =>
      Effect.gen(function* () {
        for (const stage of ["write", "rename"] as const) {
          yield* withStorage({ [documentPath]: "previous" }, (storage, controls) =>
            Effect.gen(function* () {
              controls.failWrite = stage === "write";
              controls.failRename = stage === "rename";
              const error = yield* Effect.flip(storage.save(current));
              assert.ok(Schema.is(ApplicationWriteError)(error));
              if (error._tag !== "ApplicationWriteError") throw error;
              assert.strictEqual(error.stage, stage);
              assert.strictEqual(controls.files.get(documentPath), "previous");
              assert.deepStrictEqual(controls.temporaryFiles(), []);
            }),
          );
        }
      }),
  );

  it.effect("cleans a temporary file when an in-progress write is interrupted", () =>
    withStorage({ [documentPath]: "previous" }, (storage, controls) =>
      Effect.gen(function* () {
        controls.interruptWrite = true;
        const fiber = yield* Effect.forkChild(storage.save(current));
        yield* Deferred.await(controls.writeStarted);
        assert.strictEqual(controls.temporaryFiles().length, 1);
        yield* Fiber.interrupt(fiber);
        assert.strictEqual(controls.files.get(documentPath), "previous");
        assert.deepStrictEqual(controls.temporaryFiles(), []);
      }),
    ),
  );

  it.effect("serializes concurrent writes", () =>
    withStorage({}, (storage, controls) =>
      Effect.gen(function* () {
        controls.blockWrites = true;
        const first = yield* Effect.forkChild(storage.save(current));
        yield* Deferred.await(controls.writeStarted);
        assert.strictEqual(controls.activeWrites, 1);
        const second = yield* Effect.forkChild(storage.save(current));
        yield* Effect.yieldNow;
        assert.strictEqual(controls.activeWrites, 1);
        assert.strictEqual(controls.maximumActiveWrites, 1);
        yield* Deferred.succeed(controls.releaseWrites, undefined);
        yield* Fiber.join(first);
        yield* Fiber.join(second);
        assert.strictEqual(controls.maximumActiveWrites, 1);
      }),
    ),
  );
});
