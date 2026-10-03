import type { SettingsManager } from "@earendil-works/pi-coding-agent";
import { Context, Effect, Layer, Schema, Semaphore } from "effect";
import {
  piSettingsSchema,
  type PiSettingUpdate,
  type PiSettings as PiSettingsValue,
} from "../../ipc/session-contract";
import { applyPiSetting, projectPiSettings } from "./runtime/settings-translation";

export class PiSettingsError extends Schema.TaggedError<PiSettingsError>()("PiSettingsError", {
  operation: Schema.String,
  message: Schema.String,
}) {}

export class PiSettings extends Context.Service<
  PiSettings,
  {
    readonly load: () => Effect.Effect<PiSettingsValue, PiSettingsError>;
    readonly update: (update: PiSettingUpdate) => Effect.Effect<PiSettingsValue, PiSettingsError>;
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

      return PiSettings.of({ load, update });
    }),
  );
