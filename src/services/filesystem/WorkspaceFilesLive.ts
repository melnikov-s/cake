import { homedir } from "node:os";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { Effect, Layer } from "effect";
import { ProjectAccess } from "../projects/ProjectAccess";
import { suggestProjectFiles } from "../pi/runtime/session-discovery";
import { WorkspaceFileError } from "../../contracts/filesystem/workspace-files-errors";
import { WorkspaceFiles } from "./WorkspaceFiles";
import { prepareFileLocation } from "./file-location";
import { readLocalImage } from "./local-image";
import { expandHomePath } from "./local-path";

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

      // Chat images may live anywhere on this host (for example /tmp screenshots).
      // Relative paths resolve against the conversation's Working Directory, or
      // home for global Cake Chat, which has none.
      const readImage = Effect.fn("WorkspaceFiles.readImage")(function* (_connectionId, request) {
        return yield* Effect.tryPromise({
          try: () =>
            readLocalImage(
              resolve(request.workspacePath ?? homedir(), expandHomePath(request.path)),
            ),
          catch: (cause) => workspaceFilesError("readImage", cause),
        });
      });

      return WorkspaceFiles.of({
        suggestFiles,
        prepareFileLocation: Effect.fn("WorkspaceFiles.prepareFileLocation")(
          function* (_connectionId, request) {
            if (request.workspacePath) yield* requireAllowed(request.workspacePath);
            const originatingDirectory = request.originatingDirectory ?? homedir();
            yield* requireAllowed(originatingDirectory);
            return yield* Effect.tryPromise({
              try: (signal) => prepareFileLocation({ ...request, originatingDirectory }, signal),
              catch: (cause) => workspaceFilesError("prepareFileLocation", cause),
            });
          },
        ),
        readFile: readWorkspaceFile,
        readImage,
      });
    }),
  );
