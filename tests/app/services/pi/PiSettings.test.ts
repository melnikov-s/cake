import { DEFAULT_COMPACTION_SETTINGS, SettingsManager } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import type { PiSettingUpdate } from "../../../../src/contracts/conversations/session-contract";
import { describe, expect, it } from "@effect/vitest";
import { makePiSettingsLayer, PiSettings } from "../../../../src/services/pi/PiSettings";
import { mergePiDocumentSetting } from "../../../../src/services/pi/live/PiSettingsLive";
import { projectPiSettings } from "../../../../src/services/pi/runtime/settings-translation";
import {
  nativeToolSelected,
  updateNativeToolSelection,
} from "../../../../src/renderer/lib/native-tool-settings";

const runWithSettings = <A, E>(manager: SettingsManager, effect: Effect.Effect<A, E, PiSettings>) =>
  effect.pipe(Effect.provide(makePiSettingsLayer(manager)));

const persistenceUpdates = {
  defaultModel: { key: "defaultModel", provider: "example", modelId: "example-model" },
  defaultThinkingLevel: { key: "defaultThinkingLevel", value: "high" },
  autoCompact: { key: "autoCompact", value: false },
  compactionReserveTokens: { key: "compactionReserveTokens", value: 0 },
  compactionKeepRecentTokens: { key: "compactionKeepRecentTokens", value: 0 },
  autoResizeImages: { key: "autoResizeImages", value: false },
  blockImages: { key: "blockImages", value: true },
  enableSkillCommands: { key: "enableSkillCommands", value: false },
  steeringMode: { key: "steeringMode", value: "all" },
  followUpMode: { key: "followUpMode", value: "all" },
  transport: { key: "transport", value: "websocket-cached" },
  httpIdleTimeoutMs: { key: "httpIdleTimeoutMs", value: 0 },
  hideThinkingBlock: { key: "hideThinkingBlock", value: true },
  mermaidRenderingMode: { key: "mermaidRenderingMode", value: "off" },
  showCacheMissNotices: { key: "showCacheMissNotices", value: false },
  collapseChangelog: { key: "collapseChangelog", value: true },
  quietStartup: { key: "quietStartup", value: true },
  enableInstallTelemetry: { key: "enableInstallTelemetry", value: false },
  doubleEscapeAction: { key: "doubleEscapeAction", value: "none" },
  treeFilterMode: { key: "treeFilterMode", value: "labeled-only" },
  anthropicExtraUsageWarning: { key: "anthropicExtraUsageWarning", value: false },
  retryEnabled: { key: "retryEnabled", value: false },
  defaultTools: { key: "defaultTools", value: [] },
  codemodeInlineBudget: { key: "codemodeInlineBudget", value: 0 },
  shellPath: { key: "shellPath", value: "/bin/fish" },
  shellCommandPrefix: { key: "shellCommandPrefix", value: "env CUSTOM=1" },
  npmCommand: { key: "npmCommand", value: ["pnpm", "--silent"] },
  packages: {
    key: "packages",
    value: [{ source: "example-package", extensions: ["-extension.ts"], skills: [] }],
  },
  extensions: { key: "extensions", value: ["+extension.ts", "-builtin:example"] },
  skills: { key: "skills", value: ["/custom/skills"] },
  prompts: { key: "prompts", value: ["/custom/prompts"] },
} satisfies Record<PiSettingUpdate["key"], PiSettingUpdate>;

const makeStoredSettings = () => {
  const state = { document: "{}", failWrite: false };
  const storage: Parameters<typeof SettingsManager.fromStorage>[0] = {
    withLock(scope, update) {
      if (scope !== "global") {
        update(undefined);
        return;
      }
      const next = update(state.document);
      if (next !== undefined) {
        if (state.failWrite) throw new Error("Settings write failed");
        state.document = next;
      }
    },
  };
  const manager = () => SettingsManager.fromStorage(storage, { projectTrusted: false });
  return { state, manager };
};

const failureMessage = <A, E extends { readonly message: string }>(effect: Effect.Effect<A, E>) =>
  effect.pipe(
    Effect.map(() => "unexpected success"),
    Effect.catch((error) => Effect.succeed(error.message)),
  );

// Every update key is required above, so new Pi controls require a restart-persistence case.
describe("PiSettings", () => {
  it.effect(
    "persists every exposed Pi setting across fresh managers, including false, zero and empty lists",
    () => {
      const stored = makeStoredSettings();
      return Effect.gen(function* () {
        const settings = yield* PiSettings;
        for (const update of Object.values(persistenceUpdates)) {
          const committed = yield* settings.update(update);
          const loaded = yield* runWithSettings(
            stored.manager(),
            Effect.flatMap(PiSettings, (fresh) => fresh.load()),
          );
          if (update.key === "defaultModel") {
            expect(loaded.defaultProvider).toBe(update.provider);
            expect(loaded.defaultModel).toBe(update.modelId);
          } else {
            expect(loaded[update.key], update.key).toEqual(update.value);
          }
          expect(loaded).toEqual(committed);
        }
      }).pipe(
        Effect.provide(
          makePiSettingsLayer(stored.manager(), (update) =>
            Effect.sync(() => {
              stored.state.document = JSON.stringify(
                mergePiDocumentSetting(JSON.parse(stored.state.document), update),
              );
            }),
          ),
        ),
      );
    },
  );

  it.effect("persists after repairing a settings document that previously failed to load", () => {
    const stored = makeStoredSettings();
    return runWithSettings(
      stored.manager(),
      Effect.gen(function* () {
        const settings = yield* PiSettings;
        stored.state.document = "{";
        expect(yield* failureMessage(settings.load())).not.toBe("unexpected success");
        stored.state.document = "{}";
        yield* settings.update({ key: "shellPath", value: "/bin/fish" });
        expect(JSON.parse(stored.state.document).shellPath).toBe("/bin/fish");
      }),
    );
  });

  it.effect("rejects every mutation while the authoritative document is malformed", () => {
    const stored = makeStoredSettings();
    return runWithSettings(
      stored.manager(),
      Effect.gen(function* () {
        const settings = yield* PiSettings;
        stored.state.document = "{";
        expect(yield* failureMessage(settings.load())).not.toBe("unexpected success");
        expect(
          yield* failureMessage(settings.update({ key: "shellPath", value: "/bin/fish" })),
        ).not.toBe("unexpected success");
        expect(stored.state.document).toBe("{");
      }),
    );
  });

  it.effect("reports write failures and persists a subsequent retry", () => {
    const stored = makeStoredSettings();
    return runWithSettings(
      stored.manager(),
      Effect.gen(function* () {
        const settings = yield* PiSettings;
        stored.state.failWrite = true;
        expect(
          yield* failureMessage(settings.update({ key: "blockImages", value: true })),
        ).toContain("Settings write failed");
        expect(stored.state.document).toBe("{}");
        stored.state.failWrite = false;
        yield* settings.update({ key: "blockImages", value: true });
        expect(JSON.parse(stored.state.document).images.blockImages).toBe(true);
      }),
    );
  });

  it.effect("preserves externally changed warning fields when updating one warning", () => {
    const stored = makeStoredSettings();
    return runWithSettings(
      stored.manager(),
      Effect.gen(function* () {
        const settings = yield* PiSettings;
        stored.state.document = JSON.stringify({ warnings: { extensionWarning: false } });
        yield* settings.update({ key: "anthropicExtraUsageWarning", value: false });
        expect(JSON.parse(stored.state.document).warnings).toEqual({
          extensionWarning: false,
          anthropicExtraUsage: false,
        });
      }),
    );
  });

  it.effect(
    "persists extension toggles and rejects malformed storage before extension callbacks",
    () => {
      const stored = makeStoredSettings();
      const manager = stored.manager();
      let toggles = 0;
      return Effect.gen(function* () {
        const settings = yield* PiSettings;
        yield* settings.setExtensionEnabled({ id: "extension.ts", enabled: false });
        const loaded = yield* runWithSettings(
          stored.manager(),
          Effect.flatMap(PiSettings, (fresh) => fresh.load()),
        );
        expect(loaded.extensions).toEqual(["-extension.ts"]);
        stored.state.document = "{";
        expect(yield* failureMessage(settings.extensions())).not.toBe("unexpected success");
        expect(
          yield* failureMessage(
            settings.setExtensionEnabled({ id: "extension.ts", enabled: true }),
          ),
        ).not.toBe("unexpected success");
        expect(toggles).toBe(1);
      }).pipe(
        Effect.provide(
          makePiSettingsLayer(manager, undefined, {
            list: () => Effect.succeed([]),
            toggle: (toggle) =>
              Effect.sync(() => {
                toggles += 1;
                manager.setExtensionPaths([`${toggle.enabled ? "+" : "-"}${toggle.id}`]);
              }),
          }),
        ),
      );
    },
  );

  it.effect(
    "persists exact native execution fields, preserves unrelated settings and reloads Pi selection semantics",
    () => {
      let document = JSON.stringify({
        defaultTools: ["-bash", "+grep"],
        codemode: { mode: "only", inlineBudget: 4500 },
        unknownExtensionField: { enabled: true },
      });
      const storage: Parameters<typeof SettingsManager.fromStorage>[0] = {
        withLock(scope, update) {
          if (scope === "global") {
            const next = update(document);
            if (next !== undefined) document = next;
          } else update(undefined);
        },
      };
      const manager = SettingsManager.fromStorage(storage, { projectTrusted: true });
      return Effect.gen(function* () {
        const settings = yield* PiSettings;
        expect((yield* settings.load()).defaultTools).toEqual(["-bash", "+grep"]);
        const enabled = updateNativeToolSelection(["-bash", "+grep"], "codemode", true);
        yield* settings.update({ key: "defaultTools", value: enabled });
        expect(manager.getDefaultTools()).toEqual(["read", "edit", "write", "grep", "codemode"]);
        yield* settings.update({ key: "codemodeInlineBudget", value: 0 });
        expect(JSON.parse(document)).toEqual({
          defaultTools: ["-bash", "+grep", "+codemode"],
          codemode: { mode: "only", inlineBudget: 0 },
          unknownExtensionField: { enabled: true },
        });
        yield* settings.update({ key: "defaultTools", value: [] });
        expect(manager.getDefaultTools()).toEqual([]);
        yield* settings.update({ key: "defaultTools", value: null });
        expect(manager.getDefaultTools()).toEqual(["read", "bash", "edit", "write", "codemode"]);
        expect((yield* settings.load()).defaultTools).toEqual(["+codemode"]);
      }).pipe(
        Effect.provide(
          makePiSettingsLayer(manager, (update) =>
            Effect.sync(() => {
              document = JSON.stringify(mergePiDocumentSetting(JSON.parse(document), update));
            }),
          ),
        ),
      );
    },
  );

  it.effect(
    "shows the compaction settings Pi has in effect and writes each one without dropping other settings",
    () => {
      const modelOverrides = { "example/model": { reserveTokens: 4_000 } };
      let document = JSON.stringify({
        theme: "dark",
        compaction: { enabled: false, modelOverrides },
        unknownExtensionField: { enabled: true },
      });
      const storage: Parameters<typeof SettingsManager.fromStorage>[0] = {
        withLock(scope, update) {
          if (scope === "global") {
            const next = update(document);
            if (next !== undefined) document = next;
          } else update(undefined);
        },
      };
      const manager = SettingsManager.fromStorage(storage, { projectTrusted: false });
      return Effect.gen(function* () {
        const settings = yield* PiSettings;
        // Stored: only "enabled". The token values are Pi's own defaults, not Cake's.
        expect(yield* settings.load()).toMatchObject({
          autoCompact: false,
          compactionReserveTokens: DEFAULT_COMPACTION_SETTINGS.reserveTokens,
          compactionKeepRecentTokens: DEFAULT_COMPACTION_SETTINGS.keepRecentTokens,
        });

        const reserved = yield* settings.update({ key: "compactionReserveTokens", value: 32_000 });
        expect(reserved).toMatchObject({ autoCompact: false, compactionReserveTokens: 32_000 });
        expect(JSON.parse(document)).toEqual({
          theme: "dark",
          compaction: { enabled: false, reserveTokens: 32_000, modelOverrides },
          unknownExtensionField: { enabled: true },
        });

        yield* settings.update({ key: "compactionKeepRecentTokens", value: 0 });
        const enabled = yield* settings.update({ key: "autoCompact", value: true });
        expect(enabled).toMatchObject({
          autoCompact: true,
          compactionReserveTokens: 32_000,
          compactionKeepRecentTokens: 0,
        });
        expect(JSON.parse(document)).toEqual({
          theme: "dark",
          compaction: { enabled: true, reserveTokens: 32_000, keepRecentTokens: 0, modelOverrides },
          unknownExtensionField: { enabled: true },
        });
        // A session started now reads the same file through its own Pi manager.
        expect(
          SettingsManager.fromStorage(storage, { projectTrusted: false }).getCompactionSettings(),
        ).toEqual({ enabled: true, reserveTokens: 32_000, keepRecentTokens: 0 });
      }).pipe(
        Effect.provide(
          makePiSettingsLayer(manager, (update) =>
            Effect.sync(() => {
              document = JSON.stringify(mergePiDocumentSetting(JSON.parse(document), update));
            }),
          ),
        ),
      );
    },
  );

  it("projects a session's compaction settings with Pi's project-over-global precedence", () => {
    const documents = {
      global: JSON.stringify({ compaction: { enabled: false, keepRecentTokens: 9_000 } }),
      project: JSON.stringify({ compaction: { enabled: true, reserveTokens: 5_000 } }),
    };
    const storage: Parameters<typeof SettingsManager.fromStorage>[0] = {
      withLock(scope, update) {
        update(documents[scope]);
      },
    };
    expect(
      projectPiSettings(SettingsManager.fromStorage(storage, { projectTrusted: true })),
    ).toMatchObject({
      autoCompact: true,
      compactionReserveTokens: 5_000,
      compactionKeepRecentTokens: 9_000,
    });
    // An untrusted project's file is ignored, exactly as Pi ignores it.
    expect(
      projectPiSettings(SettingsManager.fromStorage(storage, { projectTrusted: false })),
    ).toMatchObject({
      autoCompact: false,
      compactionReserveTokens: DEFAULT_COMPACTION_SETTINGS.reserveTokens,
      compactionKeepRecentTokens: 9_000,
    });
  });

  it.effect(
    "shows Pi's default for a hand-edited invalid compaction value so Settings can repair it",
    () => {
      const stored = makeStoredSettings();
      stored.state.document = JSON.stringify({ compaction: { reserveTokens: -1 } });
      return Effect.gen(function* () {
        const settings = yield* PiSettings;
        expect((yield* settings.load()).compactionReserveTokens).toBe(
          DEFAULT_COMPACTION_SETTINGS.reserveTokens,
        );
        yield* settings.update({ key: "compactionReserveTokens", value: 12_000 });
        expect(stored.manager().getCompactionReserveTokens()).toBe(12_000);
      }).pipe(
        Effect.provide(
          makePiSettingsLayer(stored.manager(), (update) =>
            Effect.sync(() => {
              stored.state.document = JSON.stringify(
                mergePiDocumentSetting(JSON.parse(stored.state.document), update),
              );
            }),
          ),
        ),
      );
    },
  );

  it("enables codemode in the unconfigured Cake selection and preserves opt-outs", () => {
    expect(nativeToolSelected(null, "codemode")).toBe(true);
    expect(nativeToolSelected(null, "tool_search")).toBe(false);
    expect(nativeToolSelected([], "codemode")).toBe(false);
    expect(nativeToolSelected(["-codemode"], "codemode")).toBe(false);
    expect(updateNativeToolSelection(null, "tool_search", true)).toEqual([
      "+codemode",
      "+tool_search",
    ]);
  });

  it("preserves explicit replacement, inherited +/- and explicit empty tool selections when toggling", () => {
    const cases: (readonly string[] | null)[] = [
      null,
      [],
      ["codemode"],
      ["read", "-bash", "+grep"],
      ["+codemode", "-read", "+grep"],
    ];
    for (const selection of cases) {
      for (const enabled of [true, false]) {
        const next = updateNativeToolSelection(selection, "codemode", enabled);
        expect(nativeToolSelected(next, "codemode")).toBe(enabled);
        for (const name of ["read", "bash", "grep", "write"])
          expect(nativeToolSelected(next, name)).toBe(nativeToolSelected(selection, name));
      }
    }
  });

  it.effect("loads Pi settings without acquiring a conversation runtime", () => {
    const manager = SettingsManager.inMemory({
      shellPath: "/bin/zsh",
      steeringMode: "all",
      packages: ["example-package"],
    });

    return Effect.gen(function* () {
      const settings = yield* PiSettings;
      const loaded = yield* settings.load();

      expect(loaded.shellPath).toBe("/bin/zsh");
      expect(loaded.steeringMode).toBe("all");
      expect(loaded.packages).toEqual(["example-package"]);
      expect(loaded.reloadPending).toBe(false);
    }).pipe(Effect.provide(makePiSettingsLayer(manager)));
  });

  it.effect("projects Pi's header-only startup setting through Cake's boolean control", () => {
    const manager = SettingsManager.inMemory({ quietStartup: "header" });
    return runWithSettings(
      manager,
      Effect.gen(function* () {
        const settings = yield* PiSettings;
        expect((yield* settings.load()).quietStartup).toBe(true);
        expect(manager.getQuietStartup()).toBe("header");
        expect((yield* settings.update({ key: "quietStartup", value: false })).quietStartup).toBe(
          false,
        );
        expect(manager.getQuietStartup()).toBe(false);
        expect((yield* settings.update({ key: "quietStartup", value: true })).quietStartup).toBe(
          true,
        );
        expect(manager.getQuietStartup()).toBe(true);
      }),
    );
  });

  it.effect("persists updates through Pi's settings manager", () => {
    const manager = SettingsManager.inMemory();

    return runWithSettings(
      manager,
      Effect.gen(function* () {
        const settings = yield* PiSettings;
        const updated = yield* settings.update({ key: "shellPath", value: "/bin/fish" });

        expect(updated.shellPath).toBe("/bin/fish");
        expect(manager.getShellPath()).toBe("/bin/fish");
      }),
    );
  });
});
