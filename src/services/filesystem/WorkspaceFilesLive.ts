import { homedir } from "node:os";
import { open, realpath } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { Effect, Layer } from "effect";
import { ProjectAccess } from "../projects/ProjectAccess";
import { suggestProjectFiles } from "../pi/runtime/session-discovery";
import { cakeChatSideChatParentId } from "../../contracts/cake-chats/cake-chat-identity";
import { WorkspaceFileError } from "../../contracts/filesystem/workspace-files-errors";
import { WorkspaceFiles } from "./WorkspaceFiles";
import { prepareFileLocation } from "./file-location";
import { readReferencedImage } from "./local-image";
import {
  cakeChatScratchDirectory,
  cakeChatSessionDirectory,
} from "../pi-durable/cake-chat-directories";

const workspaceFilesError = (operation: string, cause: unknown) =>
  new WorkspaceFileError({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
  });

// Preserve readFile("utf8") semantics: 2,000,000 UTF-16 code units, not bytes,
// including replacement characters for malformed UTF-8 and a retained BOM.
async function readWorkspaceText(target: string, signal: AbortSignal) {
  const maxLength = 2_000_000;
  signal.throwIfAborted();
  const handle = await open(target, "r");
  try {
    const buffer = Buffer.alloc(64 * 1_024);
    const decoder = new StringDecoder("utf8");
    const chunks: string[] = [];
    let length = 0;
    while (true) {
      signal.throwIfAborted();
      // A byte yields at most one code unit unless it completes a pending UTF-8
      // sequence. Read only enough to detect overflow, including after file growth.
      const { bytesRead } = await handle.read(
        buffer,
        0,
        Math.min(buffer.length, maxLength - length + 1),
        null,
      );
      signal.throwIfAborted();
      const chunk = bytesRead === 0 ? decoder.end() : decoder.write(buffer.subarray(0, bytesRead));
      length += chunk.length;
      if (length > maxLength) throw new Error("File is too large to display");
      chunks.push(chunk);
      if (bytesRead === 0) return chunks.join("");
    }
  } finally {
    await handle.close();
  }
}

/** `cakeChatDirectory` is global Cake Chat's session directory; other chats derive theirs from it. */
export const makeWorkspaceFilesLive = (agentDirectory: string, cakeChatDirectory: string) =>
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

      /** Where a Cake Chat's commands start; its side chats start there too unless bound elsewhere. */
      const chatScratchDirectory = (sessionId: string | undefined) => {
        if (!sessionId) return undefined;
        const chat = cakeChatSideChatParentId(sessionId) ?? sessionId;
        const directory = cakeChatSessionDirectory(cakeChatDirectory, chat);
        return directory && cakeChatScratchDirectory(directory);
      };

      const suggestFiles = Effect.fn("WorkspaceFiles.suggestFiles")(function* (
        _connectionId: number,
        request: Parameters<WorkspaceFiles["Service"]["suggestFiles"]>[1],
      ) {
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
      });

      const readWorkspaceFile = Effect.fn("WorkspaceFiles.readFile")(function* (
        _connectionId: number,
        request: Parameters<WorkspaceFiles["Service"]["readFile"]>[1],
      ) {
        yield* requireAllowed(request.workspacePath);
        if (isAbsolute(request.path))
          return yield* new WorkspaceFileError({
            operation: "readFile",
            message: "Workspace file path must be relative",
          });
        const content = yield* Effect.tryPromise({
          try: async (signal) => {
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
            return readWorkspaceText(target, signal);
          },
          catch: (cause) => workspaceFilesError("readFile", cause),
        });
        return { content };
      });

      // Chat images may live anywhere on this host (for example /tmp screenshots).
      // Relative paths try the author's working directory first: a Cake Chat's scratch
      // directory, where its commands start, or a Project Session's checkout. Then the
      // project root, then home when nothing else is known (global Cake Chat).
      const readImage = Effect.fn("WorkspaceFiles.readImage")(function* (
        _connectionId: number,
        request: Parameters<WorkspaceFiles["Service"]["readImage"]>[1],
      ) {
        const directories = [
          chatScratchDirectory(request.sessionId),
          request.workspacePath,
          request.projectPath,
        ];
        if (!request.workspacePath && !request.projectPath) directories.push(homedir());
        return yield* Effect.tryPromise({
          try: () => readReferencedImage(request.path, directories),
          catch: (cause) => workspaceFilesError("readImage", cause),
        });
      });

      return WorkspaceFiles.of({
        suggestFiles,
        prepareFileLocation: Effect.fn("WorkspaceFiles.prepareFileLocation")(function* (
          _connectionId: number,
          request: Parameters<WorkspaceFiles["Service"]["prepareFileLocation"]>[1],
        ) {
          if (request.workspacePath) yield* requireAllowed(request.workspacePath);
          const originatingDirectory = request.originatingDirectory ?? homedir();
          yield* requireAllowed(originatingDirectory);
          const scratch = chatScratchDirectory(request.sessionId);
          const authorDirectories = scratch ? [scratch] : [];
          return yield* Effect.tryPromise({
            try: (signal) =>
              prepareFileLocation({ ...request, originatingDirectory, authorDirectories }, signal),
            catch: (cause) => workspaceFilesError("prepareFileLocation", cause),
          });
        }),
        readFile: readWorkspaceFile,
        readImage,
      });
    }),
  );
