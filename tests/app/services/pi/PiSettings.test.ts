import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { describe, expect, it } from "@effect/vitest";
import { makePiSettingsLayer, PiSettings } from "../../../../src/services/pi/PiSettings";
import { mergePiExecutionSetting } from "../../../../src/services/pi/live/PiSettingsLive";
import {
  nativeToolSelected,
  updateNativeToolSelection,
} from "../../../../src/renderer/lib/native-tool-settings";

const runWithSettings = <A, E>(manager: SettingsManager, effect: Effect.Effect<A, E, PiSettings>) =>
  effect.pipe(Effect.provide(makePiSettingsLayer(manager)));

describe("PiSettings", () => {
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
        expect(manager.getDefaultTools()).toBeUndefined();
        expect((yield* settings.load()).defaultTools).toBeNull();
      }).pipe(
        Effect.provide(
          makePiSettingsLayer(manager, (update) =>
            Effect.sync(() => {
              document = JSON.stringify(mergePiExecutionSetting(JSON.parse(document), update));
            }),
          ),
        ),
      );
    },
  );

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
