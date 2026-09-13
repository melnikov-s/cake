import { Effect, Schema } from "effect";
import { readFile, realpath, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, relative, resolve, sep } from "node:path";
import {
  MAX_ARTIFACT_INPUT_BYTES,
  parseArtifactInput,
  type CakeArtifactV1,
} from "../../ipc/artifact-contract";

/** Largest binary worth reading before base64 expansion can exceed the v1 input limit. */
export const MAX_FILE_ARTIFACT_BYTES = Math.floor(MAX_ARTIFACT_INPUT_BYTES / 4) * 3;

const mimeTypes = new Map<string, string>([
  [".avif", "image/avif"],
  [".css", "text/css"],
  [".csv", "text/csv"],
  [".gif", "image/gif"],
  [".gz", "application/gzip"],
  [".html", "text/html"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript"],
  [".json", "application/json"],
  [".md", "text/markdown"],
  [".mov", "video/quicktime"],
  [".mp3", "audio/mpeg"],
  [".mp4", "video/mp4"],
  [".ogg", "audio/ogg"],
  [".pdf", "application/pdf"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".tar", "application/x-tar"],
  [".ts", "text/typescript"],
  [".tsx", "text/typescript"],
  [".txt", "text/plain"],
  [".wav", "audio/wav"],
  [".webm", "video/webm"],
  [".webp", "image/webp"],
  [".xml", "application/xml"],
  [".yaml", "application/yaml"],
  [".yml", "application/yaml"],
  [".zip", "application/zip"],
]);

export interface ImportWorkspaceFileInput {
  /** A Working Directory already authorized by ProjectAccess or the owning Pi runtime. */
  readonly workingDirectory: string;
  readonly path: string;
  readonly id: string;
  readonly sessionId: string;
  readonly revision: number;
  readonly title?: string;
}

export class FileArtifactImportError extends Schema.TaggedError<FileArtifactImportError>()(
  "FileArtifactImportError",
  { operation: Schema.String, message: Schema.String },
) {}

const importError = (operation: string, cause: unknown) =>
  new FileArtifactImportError({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
  });

/**
 * Snapshots one workspace-relative file into an immutable cake.artifact/v1 payload.
 * The intended caller must first obtain `workingDirectory` from ProjectAccess or its
 * bound Project Session runtime; this operation then enforces filesystem containment.
 */
export const importWorkspaceFile = Effect.fn("FileArtifacts.importWorkspaceFile")(function* (
  input: ImportWorkspaceFileInput,
): Effect.fn.Return<CakeArtifactV1, FileArtifactImportError> {
  const artifact = yield* Effect.tryPromise({
    try: async () => {
      const requestedPath = input.path.trim();
      if (!requestedPath) throw new Error("Workspace file path is required");
      if (isAbsolute(requestedPath)) throw new Error("Workspace file path must be relative");
      if (requestedPath.split(/[\\/]/).includes(".."))
        throw new Error("Workspace file path must not contain traversal segments");

      const workspace = await realpath(input.workingDirectory);
      const target = await realpath(resolve(workspace, requestedPath));
      const pathFromWorkspace = relative(workspace, target);
      if (
        pathFromWorkspace === "" ||
        isAbsolute(pathFromWorkspace) ||
        pathFromWorkspace === ".." ||
        pathFromWorkspace.startsWith(`..${sep}`)
      )
        throw new Error("File is outside the authorized Working Directory");

      const metadata = await stat(target);
      if (!metadata.isFile()) throw new Error("Workspace artifact path must identify a file");
      if (metadata.size > MAX_FILE_ARTIFACT_BYTES)
        throw new Error(`File exceeds the ${MAX_FILE_ARTIFACT_BYTES}-byte snapshot limit`);

      const name = basename(target);
      const mimeType = mimeTypes.get(extname(name).toLowerCase()) ?? "application/octet-stream";
      const sizeLabel = metadata.size === 1 ? "1 byte" : `${metadata.size} bytes`;
      const base64Length = 4 * Math.ceil(metadata.size / 3);
      const emptyArtifactBytes = new TextEncoder().encode(
        JSON.stringify({
          protocol: "cake.artifact/v1",
          id: input.id,
          sessionId: input.sessionId,
          revision: input.revision,
          title: input.title,
          kind: "file",
          payload: { name, mimeType, data: "", byteSize: metadata.size },
          fallback: {
            markdown: `File: \`${name.replaceAll("`", "'")}\` (${mimeType}, ${sizeLabel}).`,
          },
          interaction: { mode: "present" },
        }),
      ).byteLength;
      if (emptyArtifactBytes + base64Length > MAX_ARTIFACT_INPUT_BYTES)
        throw new Error(`File artifact exceeds the ${MAX_ARTIFACT_INPUT_BYTES}-byte input limit`);

      const content = await readFile(target);
      if (content.byteLength > MAX_FILE_ARTIFACT_BYTES)
        throw new Error(`File exceeds the ${MAX_FILE_ARTIFACT_BYTES}-byte snapshot limit`);

      const actualSizeLabel = content.byteLength === 1 ? "1 byte" : `${content.byteLength} bytes`;
      return parseArtifactInput({
        protocol: "cake.artifact/v1",
        id: input.id,
        sessionId: input.sessionId,
        revision: input.revision,
        title: input.title,
        kind: "file",
        payload: {
          name,
          mimeType,
          data: content.toString("base64"),
          byteSize: content.byteLength,
        },
        fallback: {
          markdown: `File: \`${name.replaceAll("`", "'")}\` (${mimeType}, ${actualSizeLabel}).`,
        },
        interaction: { mode: "present" },
      });
    },
    catch: (cause) => importError("importWorkspaceFile", cause),
  });
  return artifact;
});
