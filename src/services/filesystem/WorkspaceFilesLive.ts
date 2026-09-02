import { readFile, realpath } from "node:fs/promises";
import { basename, extname, isAbsolute, relative, resolve } from "node:path";
import { BrowserWindow, dialog } from "electron";
import { Effect, Layer } from "effect";
import type { Attachment } from "../../ipc/session-contract";
import { Electron } from "../electron/Electron";
import { ProjectAccess } from "../projects/ProjectAccess";
import { suggestProjectFiles } from "../pi/runtime/session-discovery";
import { WorkspaceFileError, WorkspaceFiles } from "./WorkspaceFiles";

const imageMimeTypes = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
]);

const workspaceFilesError = (operation: string, cause: unknown) =>
  new WorkspaceFileError({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
  });

export const makeWorkspaceFilesLive = (agentDirectory: string) =>
  Layer.effect(
    WorkspaceFiles,
    Effect.gen(function* () {
      const electron = yield* Electron;
      const access = yield* ProjectAccess;

      const requireAllowed = (workingDirectory: string) =>
        access.isAllowed(workingDirectory)
          ? Effect.void
          : new WorkspaceFileError({
              operation: "authorizeWorkingDirectory",
              message: "Project path was not selected by the user",
            });

      const chooseAttachments = Effect.fn("WorkspaceFiles.chooseAttachments")(function* (
        connectionId: number,
      ) {
        const sender = yield* Effect.try({
          try: () => electron.requireRendererConnection(connectionId),
          catch: (cause) => workspaceFilesError("chooseAttachments", cause),
        });
        const owner = BrowserWindow.fromWebContents(sender);
        if (!owner) return { attachments: [] };
        const result = yield* Effect.tryPromise({
          try: () => dialog.showOpenDialog(owner, { properties: ["openFile", "multiSelections"] }),
          catch: (cause) => workspaceFilesError("chooseAttachments", cause),
        });
        if (result.canceled) return { attachments: [] };
        const attachments = yield* Effect.tryPromise({
          try: () =>
            Promise.all(
              result.filePaths.slice(0, 20).map(async (path): Promise<Attachment> => {
                const mimeType = imageMimeTypes.get(extname(path).toLowerCase());
                return mimeType
                  ? {
                      kind: "image",
                      name: basename(path),
                      mimeType,
                      data: (await readFile(path)).toString("base64"),
                    }
                  : { kind: "file", name: basename(path), path };
              }),
            ),
          catch: (cause) => workspaceFilesError("chooseAttachments", cause),
        });
        return { attachments };
      });

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
              if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath))
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

      return WorkspaceFiles.of({
        chooseAttachments,
        suggestFiles,
        readFile: readWorkspaceFile,
      });
    }),
  );
