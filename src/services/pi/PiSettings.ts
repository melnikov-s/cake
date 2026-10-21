import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { Context, Effect, Layer, Schema, Semaphore } from "effect";
import {
  piSettingsSchema,
  type PiSettingUpdate,
  type PiSettings as PiSettingsValue,
} from "../../contracts/conversations/session-contract";
import { applyPiSetting, projectPiSettings } from "./runtime/settings-translation";
import {
  PiExtensionSetting,
  type PiExtensionToggle,
} from "../../contracts/pi/extension-settings-data";
import { PiSettingsError } from "../../contracts/pi/pi-settings-errors";

export class PiSettings extends Context.Service<
  PiSettings,
  {
    readonly load: () => Effect.Effect<PiSettingsValue, PiSettingsError>;
    /** What each setting resolves to when the user has not stored a value. */
    readonly defaults: () => Effect.Effect<PiSettingsValue, PiSettingsError>;
    readonly update: (update: PiSettingUpdate) => Effect.Effect<PiSettingsValue, PiSettingsError>;
    readonly extensions: () => Effect.Effect<ReadonlyArray<PiExtensionSetting>, PiSettingsError>;
    readonly setExtensionEnabled: (
      toggle: PiExtensionToggle,
    ) => Effect.Effect<PiSettingsValue, PiSettingsError>;
  }
>()("cake/services/pi/PiSettings") {}

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const settingsError = (operation: string, cause: unknown) =>
  new PiSettingsError({ operation, message: messageOf(cause) });

export type PiExecutionSettingUpdate = Extract<
  PiSettingUpdate,
  { key: "defaultTools" | "codemodeInlineBudget" }
>;

export const makePiSettingsLayer = (
  settingsManager: SettingsManager,
  writeExecutionSetting?: (
    update: PiExecutionSettingUpdate,
  ) => Effect.Effect<void, PiSettingsError>,
  extensionSettings?: {
    readonly list: () => Effect.Effect<ReadonlyArray<PiExtensionSetting>, PiSettingsError>;
    readonly toggle: (toggle: PiExtensionToggle) => Effect.Effect<void, PiSettingsError>;
  },
) =>
  Layer.effect(
    PiSettings,
    Effect.gen(function* () {
      // Pi's settings file is the authority. This process-lifetime manager is serialized so
      // concurrent renderer windows cannot interleave reload, mutation, and flush operations.
      const lock = yield* Semaphore.make(1);

      const read = Effect.fn("PiSettings.read")(function* (operation: string) {
        const projected = projectPiSettings(settingsManager);
        return yield* Schema.decodeUnknownEffect(piSettingsSchema)(projected).pipe(
          Effect.mapError((cause) => settingsError(operation, cause)),
        );
      });

      const load = Effect.fn("PiSettings.load")(() =>
        lock.withPermits(1)(
          Effect.gen(function* () {
            yield* Effect.tryPromise({
              try: () => settingsManager.reload(),
              catch: (cause) => settingsError("load", cause),
            });
            const errors = settingsManager.drainErrors();
            if (errors.length > 0)
              return yield* settingsError(
                "load",
                errors.map((error) => error.error.message).join("\n"),
              );
            return yield* read("load");
          }),
        ),
      );

      const update = Effect.fn("PiSettings.update")((setting: PiSettingUpdate) =>
        lock.withPermits(1)(
          Effect.gen(function* () {
            if (setting.key === "defaultTools" || setting.key === "codemodeInlineBudget") {
              if (!writeExecutionSetting)
                return yield* settingsError("update", "Execution settings storage is unavailable");
              // Pi exposes these settings but has no public setters. Persist only the native
              // fields through the backend adapter, then reload Pi's authoritative manager.
              yield* writeExecutionSetting(setting);
              yield* Effect.tryPromise({
                try: () => settingsManager.reload(),
                catch: (cause) => settingsError("update", cause),
              });
            } else {
              yield* Effect.try({
                try: () => applyPiSetting(settingsManager, setting),
                catch: (cause) => settingsError("update", cause),
              });
            }
            yield* Effect.tryPromise({
              try: () => settingsManager.flush(),
              catch: (cause) => settingsError("update", cause),
            });
            const errors = settingsManager.drainErrors();
            if (errors.length > 0)
              return yield* settingsError(
                "update",
                errors.map((error) => error.error.message).join("\n"),
              );
            return yield* read("update");
          }),
        ),
      );

      const extensions = Effect.fn("PiSettings.extensions")(() =>
        lock.withPermits(1)(
          Effect.gen(function* () {
            if (!extensionSettings)
              return yield* settingsError("extensions", "Extension discovery is unavailable");
            yield* Effect.tryPromise({
              try: () => settingsManager.reload(),
              catch: (cause) => settingsError("extensions", cause),
            });
            yield* read("extensions");
            return yield* extensionSettings.list().pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(PiExtensionSetting))),
              Effect.mapError((cause) => settingsError("extensions", cause)),
            );
          }),
        ),
      );
      const setExtensionEnabled = Effect.fn("PiSettings.setExtensionEnabled")(
        (toggle: PiExtensionToggle) =>
          lock.withPermits(1)(
            Effect.gen(function* () {
              if (!extensionSettings)
                return yield* settingsError(
                  "setExtensionEnabled",
                  "Extension discovery is unavailable",
                );
              yield* Effect.tryPromise({
                try: () => settingsManager.reload(),
                catch: (cause) => settingsError("setExtensionEnabled", cause),
              });
              yield* read("setExtensionEnabled");
              yield* extensionSettings.toggle(toggle);
              yield* Effect.tryPromise({
                try: () => settingsManager.flush(),
                catch: (cause) => settingsError("setExtensionEnabled", cause),
              });
              const errors = settingsManager.drainErrors();
              if (errors.length)
                return yield* settingsError(
                  "setExtensionEnabled",
                  errors.map((error) => error.error.message).join("\n"),
                );
              return yield* read("setExtensionEnabled");
            }),
          ),
      );
      const defaults = Effect.fn("PiSettings.defaults")(() =>
        Schema.decodeUnknownEffect(piSettingsSchema)(
          projectPiSettings(SettingsManager.inMemory()),
        ).pipe(Effect.mapError((cause) => settingsError("defaults", cause))),
      );
      return PiSettings.of({ load, defaults, update, extensions, setExtensionEnabled });
    }),
  );
