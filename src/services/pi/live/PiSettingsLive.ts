import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { Effect, FileSystem, Layer, Path, Schema } from "effect";
import { makePiSettingsLayer, type PiExecutionSettingUpdate } from "../PiSettings";
import { PiSettingsError } from "../../../contracts/pi/pi-settings-errors";
import { cakeDefaultTools } from "../../../contracts/pi/native-tool-defaults";
import { atomicWriteFile } from "../../storage/internal/atomicFile";
import { listPiExtensionSettings, togglePiExtensionSetting } from "./PiExtensionSettings";

const settingsObject = Schema.Record(Schema.String, Schema.Unknown);
interface PiGlobalSettingsDocument extends Schema.Schema.Type<typeof settingsObject> {}

/** Pure native-field merge. Preserve all unrelated settings, including codemode.mode. */
export function mergePiExecutionSetting(
  current: PiGlobalSettingsDocument,
  update: PiExecutionSettingUpdate,
): PiGlobalSettingsDocument {
  const next = { ...current };
  if (update.key === "defaultTools") {
    next.defaultTools = [...(update.value ?? cakeDefaultTools)];
  } else {
    const codemode =
      current.codemode === undefined
        ? {}
        : Schema.decodeUnknownSync(settingsObject)(current.codemode);
    next.codemode = { ...codemode, inlineBudget: update.value };
  }
  return next;
}

/** Pi global configuration remains on the backend, independent of any desktop or chat. */
export const makePiSettingsLive = (agentDirectory: string) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const document = path.join(agentDirectory, "settings.json");
      const error = (cause: unknown) =>
        new PiSettingsError({
          operation: "update",
          message: cause instanceof Error ? cause.message : String(cause),
        });
      const readDocument = Effect.fn("PiSettingsLive.readDocument")(function* () {
        const exists = yield* fs.exists(document).pipe(Effect.mapError(error));
        return exists
          ? yield* fs.readFileString(document).pipe(
              Effect.mapError(error),
              Effect.flatMap((text) =>
                Schema.decodeUnknownEffect(Schema.fromJsonString(settingsObject))(text).pipe(
                  Effect.mapError(error),
                ),
              ),
            )
          : {};
      });
      const writeDocument = Effect.fn("PiSettingsLive.writeDocument")(function* (
        next: PiGlobalSettingsDocument,
      ) {
        yield* atomicWriteFile(
          fs,
          path,
          document,
          `${JSON.stringify(next, null, 2)}\n`,
          (_stage, cause) => error(cause),
        );
      });
      const writeExecutionSetting = Effect.fn("PiSettingsLive.writeExecutionSetting")(function* (
        update: PiExecutionSettingUpdate,
      ) {
        // Serialized by PiSettings. Merge native fields without dropping extension settings.
        const current = yield* readDocument();
        const next = yield* Effect.try({
          try: () => mergePiExecutionSetting(current, update),
          catch: error,
        });
        yield* writeDocument(next);
      });
      // Bootstrap before runtimes open: Pi remains the settings/selection authority.
      // Explicit lists (including [] and -codemode) are never overwritten.
      const current = yield* readDocument();
      if (current.defaultTools === undefined)
        yield* writeDocument({ ...current, defaultTools: [...cakeDefaultTools] });
      const manager = yield* Effect.sync(() =>
        SettingsManager.create(agentDirectory, agentDirectory, { projectTrusted: false }),
      );
      return makePiSettingsLayer(manager, writeExecutionSetting, {
        list: Effect.fn("PiSettingsLive.extensions")(() =>
          Effect.tryPromise({
            try: () => listPiExtensionSettings(agentDirectory, manager),
            catch: error,
          }),
        ),
        toggle: Effect.fn("PiSettingsLive.setExtensionEnabled")((toggle) =>
          Effect.tryPromise({
            try: () => togglePiExtensionSetting(agentDirectory, manager, toggle),
            catch: error,
          }),
        ),
      });
    }),
  );
