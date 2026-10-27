import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { Effect, Schema } from "effect";
import {
  appendPromptFiles,
  MAX_PROMPT_CHARACTERS,
  MAX_PROMPT_FILE_BYTES,
  promptFilesSchema,
  type PromptFileSnapshot,
} from "../../contracts/conversations/prompt-files";
import { WorkspaceFileError } from "../../contracts/filesystem/workspace-files-errors";
import { ProjectAccess } from "../projects/ProjectAccess";
import { expandHomePath } from "./local-path";

/** Capture before admission. Only the resulting text crosses the dispatch boundary. */
export const snapshotPromptFiles = Effect.fn("PromptFiles.snapshot")(function* (input: {
  readonly text: string;
  readonly promptFiles?: readonly string[];
  readonly senderSessionId: string;
  readonly workingDirectory?: string;
}) {
  if (input.promptFiles === undefined) return input.text;
  const fail = (cause: unknown) =>
    new WorkspaceFileError({
      operation: "promptFiles",
      message: cause instanceof Error ? cause.message : String(cause),
    });
  const paths = yield* Schema.decodeUnknownEffect(promptFilesSchema)(input.promptFiles).pipe(
    Effect.mapError(fail),
  );
  const access = yield* ProjectAccess;
  const roots = yield* access.allowedWorkingDirectories().pipe(Effect.mapError(fail));
  return yield* Effect.tryPromise({
    try: async (signal) => {
      const allowed = await Promise.all(roots.map((root) => realpath(root)));
      const files: PromptFileSnapshot[] = [];
      let characters = input.text.length;
      for (const requestedPath of paths) {
        signal.throwIfAborted();
        const sourcePath = await realpath(
          resolve(input.workingDirectory ?? homedir(), expandHomePath(requestedPath)),
        );
        if (
          !allowed.some((root) => {
            const path = relative(root, sourcePath);
            return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
          })
        )
          throw new Error(
            `Prompt file is outside authorized Projects and Managed Worktrees: ${requestedPath}`,
          );
        const handle = await open(
          sourcePath,
          constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
        );
        try {
          const stat = await handle.stat();
          if (!stat.isFile())
            throw new Error(`Prompt file must be a regular file: ${requestedPath}`);
          if (stat.size > MAX_PROMPT_FILE_BYTES)
            throw new Error(`Prompt file exceeds ${MAX_PROMPT_FILE_BYTES} bytes: ${requestedPath}`);
          const bytes = Buffer.alloc(MAX_PROMPT_FILE_BYTES + 1);
          let total = 0;
          while (total < bytes.length) {
            signal.throwIfAborted();
            const { bytesRead } = await handle.read(bytes, total, bytes.length - total, total);
            if (bytesRead === 0) break;
            total += bytesRead;
          }
          if (total > MAX_PROMPT_FILE_BYTES)
            throw new Error(`Prompt file exceeds ${MAX_PROMPT_FILE_BYTES} bytes: ${requestedPath}`);
          const data = bytes.subarray(0, total);
          if (data.includes(0))
            throw new Error(`Prompt file must be UTF-8 text, not binary: ${requestedPath}`);
          const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data);
          characters += text.length;
          if (characters > MAX_PROMPT_CHARACTERS)
            throw new Error("Combined prompt exceeds 100000 characters");
          files.push({
            name: basename(requestedPath),
            sourcePath,
            requestedPath,
            byteLength: total,
            text,
          });
        } finally {
          await handle.close();
        }
      }
      const text = appendPromptFiles(input.text, files, input.senderSessionId);
      if (text.length > MAX_PROMPT_CHARACTERS)
        throw new Error("Combined prompt including file provenance exceeds 100000 characters");
      signal.throwIfAborted();
      return text;
    },
    catch: fail,
  });
});
