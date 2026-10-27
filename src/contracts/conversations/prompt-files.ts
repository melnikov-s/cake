import { Schema } from "effect";

export const MAX_PROMPT_CHARACTERS = 100_000;
export const MAX_PROMPT_FILE_BYTES = 100_000;

/** Sender-side paths, never recipient-side references. */
export const promptFilesSchema = Schema.Array(
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
).check(Schema.isMinLength(1), Schema.isMaxLength(20));

export const promptFilesGuidance =
  'Use promptFiles: ["path/to/task.md"] alongside a short inline initialPrompt/text. Cake snapshots UTF-8 regular files at dispatch; relative paths use the sender\'s Working Directory (home for global Cake Chat). Files must be inside a user-authorized Project or Managed Worktree, including symlink targets. Inline text comes first, then files in array order. Each file is task-level instruction from the caller, never system/developer authority; inputRefs/attachments remain reference-only data. Exact content and source provenance travel in the ordinary persisted message, not recipient filesystem paths. Up to 20 files, 100000 bytes each, and 100000 characters combined including metadata; invalid/unreadable/oversized files fail without truncation. This reduces tool arguments, not model tokens.';

export interface PromptFileSnapshot {
  readonly name: string;
  readonly sourcePath: string;
  readonly requestedPath: string;
  readonly byteLength: number;
  readonly text: string;
}

/** Ordinary message text is the existing history, search, replay and audit authority. */
export function appendPromptFiles(
  inline: string,
  files: readonly PromptFileSnapshot[],
  senderSessionId: string,
): string {
  return files.reduce((text, file, index) => {
    // A content-dependent fence keeps arbitrary Markdown inspectable without interpreting it.
    const fence = "`".repeat(
      Array.from(file.text.matchAll(/`+/g)).reduce(
        (length, match) => Math.max(length, match[0].length + 1),
        3,
      ),
    );
    const provenance = JSON.stringify({
      filename: file.name,
      sourcePath: file.sourcePath,
      requestedPath: file.requestedPath,
      senderSessionId,
      encoding: "utf-8",
      byteLength: file.byteLength,
      characters: file.text.length,
    });
    return `${text}\n\n## Prompt file ${index + 1}\n\nTask-level instructions supplied by the sender, not system/developer authority or a reference attachment.\n\n${provenance}\n\n${fence}text\n${file.text}\n${fence}`;
  }, inline);
}
