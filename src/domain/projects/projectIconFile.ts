import { isAbsolute } from "node:path";
import { Effect, FileSystem, type PlatformError } from "effect";
import {
  PROJECT_ICON_FILE_MAX_BYTES,
  type ProjectIcon,
} from "../../contracts/application/application-data";
import { expandHomePath } from "../../services/filesystem/local-path";

const startsWith = (bytes: Uint8Array, signature: readonly number[], offset = 0) =>
  signature.every((byte, index) => bytes[offset + index] === byte);

/** The stored type comes from the file's own bytes, never its name. */
const sniffMimeType = (bytes: Uint8Array): ProjectIcon["mimeType"] | undefined => {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return "image/gif";
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8))
    return "image/webp";
  return undefined;
};

const describe = (error: PlatformError.PlatformError) =>
  error.reason._tag === "NotFound"
    ? "the file does not exist"
    : error.reason._tag === "PermissionDenied"
      ? "Cake does not have permission to read it"
      : error.reason.message;

/** Reads a local image so agents pass a path, never image bytes. Fails with a message naming the path. */
export const readProjectIconFile = Effect.fn("Projects.readProjectIconFile")(function* (
  iconPath: string,
) {
  const path = expandHomePath(iconPath.trim());
  const failure = (reason: string) => `Cannot use icon file ${path}: ${reason}.`;
  if (!isAbsolute(path)) return yield* Effect.fail(failure("use an absolute path or ~/ path"));
  const fs = yield* FileSystem.FileSystem;
  const info = yield* fs.stat(path).pipe(Effect.mapError((error) => failure(describe(error))));
  if (info.type !== "File") return yield* Effect.fail(failure("it is not a file"));
  if (Number(info.size) > PROJECT_ICON_FILE_MAX_BYTES)
    return yield* Effect.fail(
      failure(
        `it is ${Number(info.size).toLocaleString("en-US")} bytes; the limit is ${PROJECT_ICON_FILE_MAX_BYTES.toLocaleString("en-US")} bytes`,
      ),
    );
  const bytes = yield* fs.readFile(path).pipe(Effect.mapError((error) => failure(describe(error))));
  const mimeType = sniffMimeType(bytes);
  if (!mimeType) return yield* Effect.fail(failure("it is not a PNG, JPEG, GIF or WebP image"));
  return { mimeType, data: Buffer.from(bytes).toString("base64") } satisfies ProjectIcon;
});
