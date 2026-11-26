import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { Effect, FileSystem, Layer, Path, Schema } from "effect";
import { makePiSettingsLayer } from "../PiSettings";
import type { PiDocumentSettingUpdate } from "../runtime/settings-translation";
import { PiSettingsError } from "../../../contracts/pi/pi-settings-errors";
import { cakeDefaultTools } from "../../../contracts/pi/native-tool-defaults";
import { atomicWriteFile } from "../../storage/internal/atomicFile";
import { listPiExtensionSettings, togglePiExtensionSetting } from "./PiExtensionSettings";

const settingsObject = Schema.Record(Schema.String, Schema.Unknown);
interface PiGlobalSettingsDocument extends Schema.Schema.Type<typeof settingsObject> {}

const nestedSettings = (document: PiGlobalSettingsDocument, key: "codemode" | "compaction") =>
  document[key] === undefined ? {} : Schema.decodeUnknownSync(settingsObject)(document[key]);

/**
 * Pure native-field merge. Preserve all unrelated settings, including codemode.mode and
 * compaction.enabled/modelOverrides.
 */
export function mergePiDocumentSetting(
  current: PiGlobalSettingsDocument,
  update: PiDocumentSettingUpdate,
): PiGlobalSettingsDocument {
  const next = { ...current };
  if (update.key === "defaultTools") {
    next.defaultTools = [...(update.value ?? cakeDefaultTools)];
  } else if (update.key === "codemodeInlineBudget") {
    next.codemode = { ...nestedSettings(current, "codemode"), inlineBudget: update.value };
  } else {
    const field = update.key === "compactionReserveTokens" ? "reserveTokens" : "keepRecentTokens";
    next.compaction = { ...nestedSettings(current, "compaction"), [field]: update.value };
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
      const writeDocumentSetting = Effect.fn("PiSettingsLive.writeDocumentSetting")(function* (
        update: PiDocumentSettingUpdate,
      ) {
        // Serialized by PiSettings. Merge native fields without dropping extension settings.
        const current = yield* readDocument();
        const next = yield* Effect.try({
          try: () => mergePiDocumentSetting(current, update),
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
      return makePiSettingsLayer(manager, writeDocumentSetting, {
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
