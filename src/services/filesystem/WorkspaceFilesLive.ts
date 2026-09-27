import { readFile, realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { Effect, Layer } from "effect";
import { ProjectAccess } from "../projects/ProjectAccess";
import { suggestProjectFiles } from "../pi/runtime/session-discovery";
import { WorkspaceFileError, WorkspaceFiles } from "./WorkspaceFiles";

const imageMimeTypes = new Map([
  [".avif", "image/avif"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
]);

const maxWorkspaceImageBytes = 8 * 1_024 * 1_024;

const workspaceFilesError = (operation: string, cause: unknown) =>
  new WorkspaceFileError({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
  });

export const makeWorkspaceFilesLive = (agentDirectory: string) =>
  Layer.effect(
    WorkspaceFiles,
    Effect.gen(function* () {
      const access = yield* ProjectAccess;

      const requireAllowed = (workingDirectory: string) =>
        access.isAllowed(workingDirectory).pipe(
          Effect.flatMap((allowed) =>
            allowed
              ? Effect.void
              : Effect.fail(
                  new WorkspaceFileError({
                    operation: "authorizeWorkingDirectory",
                    message: "Project path was not selected by the user",
                  }),
                ),
          ),
        );

      const suggestFiles = Effect.fn("WorkspaceFiles.suggestFiles")(
        function* (_connectionId, request) {
          yield* requireAllowed(request.workspacePath);
          const suggestions = yield* Effect.tryPromise({
            try: () =>
              suggestProjectFiles({
                cwd: request.workspacePath,
                prefix: request.prefix,
                agentDir: agentDirectory,
              }),
            catch: (cause) => workspaceFilesError("suggestFiles", cause),
          });
          return { suggestions };
        },
      );

      const readWorkspaceFile = Effect.fn("WorkspaceFiles.readFile")(
        function* (_connectionId, request) {
          yield* requireAllowed(request.workspacePath);
          if (isAbsolute(request.path))
            return yield* new WorkspaceFileError({
              operation: "readFile",
              message: "Workspace file path must be relative",
            });
          const content = yield* Effect.tryPromise({
            try: async () => {
              const workspace = await realpath(request.workspacePath);
              const target = await realpath(resolve(workspace, request.path));
              const relativePath = relative(workspace, target);
              if (
                !relativePath ||
                relativePath === ".." ||
                relativePath.startsWith(`..${sep}`) ||
                isAbsolute(relativePath)
              )
                throw new Error("File is outside the selected project");
              const value = await readFile(target, "utf8");
              if (value.length > 2_000_000) throw new Error("File is too large to display");
              return value;
            },
            catch: (cause) => workspaceFilesError("readFile", cause),
          });
          return { content };
        },
      );

      const readWorkspaceImage = Effect.fn("WorkspaceFiles.readImage")(
        function* (_connectionId, request) {
          yield* requireAllowed(request.workspacePath);
          if (isAbsolute(request.path))
            return yield* new WorkspaceFileError({
              operation: "readImage",
              message: "Workspace image path must be relative",
            });
          const image = yield* Effect.tryPromise({
            try: async () => {
              const workspace = await realpath(request.workspacePath);
              const target = await realpath(resolve(workspace, request.path));
              const relativePath = relative(workspace, target);
              if (
                !relativePath ||
                relativePath === ".." ||
                relativePath.startsWith(`..${sep}`) ||
                isAbsolute(relativePath)
              )
                throw new Error("Image is outside the selected project");
              const mimeType = imageMimeTypes.get(extname(target).toLowerCase());
              if (!mimeType) throw new Error("Workspace image type is not supported");
              const metadata = await stat(target);
              if (!metadata.isFile()) throw new Error("Workspace image path must identify a file");
              if (metadata.size > maxWorkspaceImageBytes)
                throw new Error("Workspace image is too large to display");
              const data = await readFile(target);
              if (data.byteLength > maxWorkspaceImageBytes)
                throw new Error("Workspace image is too large to display");
              return { data: data.toString("base64"), mimeType };
            },
            catch: (cause) => workspaceFilesError("readImage", cause),
          });
          return image;
        },
      );

      return WorkspaceFiles.of({
        suggestFiles,
        readFile: readWorkspaceFile,
        readImage: readWorkspaceImage,
      });
    }),
  );
