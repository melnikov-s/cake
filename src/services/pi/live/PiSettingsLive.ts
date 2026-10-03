import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { Effect, FileSystem, Layer, Path, Schema } from "effect";
import { makePiSettingsLayer, PiSettingsError, type PiExecutionSettingUpdate } from "../PiSettings";
import { atomicWriteFile } from "../../storage/internal/atomicFile";

const settingsObject = Schema.Record(Schema.String, Schema.Unknown);
interface PiGlobalSettingsDocument extends Schema.Schema.Type<typeof settingsObject> {}

/** Pure native-field merge. Preserve all unrelated settings, including codemode.mode. */
export function mergePiExecutionSetting(
  current: PiGlobalSettingsDocument,
  update: PiExecutionSettingUpdate,
): PiGlobalSettingsDocument {
  const next = { ...current };
  if (update.key === "defaultTools") {
    if (update.value === null) delete next.defaultTools;
    else next.defaultTools = [...update.value];
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
      const writeExecutionSetting = Effect.fn("PiSettingsLive.writeExecutionSetting")(function* (
        update: PiExecutionSettingUpdate,
      ) {
        // Serialized with all global Pi settings operations by PiSettings. Read/merge
        // the original document rather than rewriting Pi's known-settings projection.
        const exists = yield* fs.exists(document).pipe(Effect.mapError(error));
        const current = exists
          ? yield* fs.readFileString(document).pipe(
              Effect.mapError(error),
              Effect.flatMap((text) =>
                Schema.decodeUnknownEffect(Schema.fromJsonString(settingsObject))(text).pipe(
                  Effect.mapError(error),
                ),
              ),
            )
          : {};
        const next = yield* Effect.try({
          try: () => mergePiExecutionSetting(current, update),
          catch: error,
        });
        yield* atomicWriteFile(
          fs,
          path,
          document,
          `${JSON.stringify(next, null, 2)}\n`,
          (_stage, cause) => error(cause),
        );
      });
      const manager = yield* Effect.sync(() =>
        SettingsManager.create(agentDirectory, agentDirectory, { projectTrusted: true }),
      );
      return makePiSettingsLayer(manager, writeExecutionSetting);
    }),
  );
