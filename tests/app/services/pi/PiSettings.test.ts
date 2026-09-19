import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { describe, expect, it } from "@effect/vitest";
import { makePiSettingsLayer, PiSettings } from "../../../../src/services/pi/PiSettings";

const runWithSettings = <A, E>(manager: SettingsManager, effect: Effect.Effect<A, E, PiSettings>) =>
  effect.pipe(Effect.provide(makePiSettingsLayer(manager)));

describe("PiSettings", () => {
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
