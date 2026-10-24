import { Effect, FileSystem, Path, Schema } from "effect";
import {
  defaultDesktopSharingPreferences,
  DesktopSharingError,
  DesktopSharingPreferences,
} from "../../contracts/desktop/desktop-sharing-data";
import { atomicWriteFile } from "./internal/atomicFile";

const fileName = "desktop-sharing.json";
const Document = Schema.Struct({
  version: Schema.Literal(1),
  preferences: DesktopSharingPreferences,
});
const storageError = (cause: { readonly message: string }) =>
  new DesktopSharingError({
    message: `Could not read browser sharing preferences: ${cause.message}`,
  });

/** Device-local connection preferences only. Listener enablement is never persisted. */
export const loadDesktopSharingPreferences = Effect.fn("DesktopSharingPreferences.load")(function* (
  directory: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const target = path.join(directory, fileName);
  if (!(yield* fs.exists(target).pipe(Effect.mapError(storageError))))
    return defaultDesktopSharingPreferences();
  const text = yield* fs.readFileString(target).pipe(Effect.mapError(storageError));
  const document = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Document))(text).pipe(
    Effect.mapError(storageError),
  );
  return document.preferences;
});

export const saveDesktopSharingPreferences = Effect.fn("DesktopSharingPreferences.save")(function* (
  directory: string,
  input: DesktopSharingPreferences,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const preferences = yield* Schema.decodeUnknownEffect(DesktopSharingPreferences)(input).pipe(
    Effect.mapError((cause) => new DesktopSharingError({ message: cause.message })),
  );
  const content = yield* Schema.encodeEffect(Schema.fromJsonString(Document))({
    version: 1,
    preferences,
  }).pipe(Effect.mapError((cause) => new DesktopSharingError({ message: cause.message })));
  yield* atomicWriteFile(
    fs,
    path,
    path.join(directory, fileName),
    content,
    (stage) =>
      new DesktopSharingError({
        message: `Could not save browser sharing preferences (${stage}).`,
      }),
  );
  return preferences;
});
