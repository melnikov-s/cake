import { Effect, FileSystem, Path, Schema } from "effect";
import { DesktopSharingError } from "../../contracts/desktop/desktop-sharing-data";
import { atomicWriteFile } from "./internal/atomicFile";

const Bindings = Schema.Array(
  Schema.Struct({ email: Schema.String, subject: Schema.NonEmptyString }),
);
export type RemoteAccessBindings = typeof Bindings.Type;
const error = () =>
  new DesktopSharingError({ message: "Could not read or save remote-access account bindings." });

export const loadRemoteAccessBindings = Effect.fn("RemoteAccessBindings.load")(function* (
  directory: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const target = path.join(directory, "remote-access-bindings.json");
  if (!(yield* fs.exists(target).pipe(Effect.mapError(error)))) return [];
  const content = yield* fs.readFileString(target).pipe(Effect.mapError(error));
  return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Bindings))(content).pipe(
    Effect.mapError(error),
  );
});

export const saveRemoteAccessBindings = Effect.fn("RemoteAccessBindings.save")(function* (
  directory: string,
  bindings: RemoteAccessBindings,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const content = yield* Schema.encodeEffect(Schema.fromJsonString(Bindings))(bindings).pipe(
    Effect.mapError(error),
  );
  yield* atomicWriteFile(
    fs,
    path,
    path.join(directory, "remote-access-bindings.json"),
    content,
    error,
  );
});
