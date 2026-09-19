import { writeFile } from "node:fs/promises";
import { relative, sep } from "node:path";
import { Context, Effect, Layer, Schema } from "effect";
import { resolveSourceTarget } from "../vscode/source-path-policy";

export interface WorkspaceFileExportInput {
  readonly workingDirectory: string;
  readonly path: string;
  readonly content: Uint8Array;
}

interface WorkspaceFileExportResult {
  readonly path: string;
  readonly bytes: number;
}

class WorkspaceFileExportError extends Schema.TaggedError<WorkspaceFileExportError>()(
  "WorkspaceFileExportError",
  { message: Schema.String },
) {}

export interface WorkspaceFileExportService {
  readonly write: (
    input: WorkspaceFileExportInput,
    signal: AbortSignal,
  ) => Effect.Effect<WorkspaceFileExportResult, WorkspaceFileExportError>;
}

export class WorkspaceFileExport extends Context.Service<
  WorkspaceFileExport,
  WorkspaceFileExportService
>()("cake/services/filesystem/WorkspaceFileExport") {}

/** Writes an explicitly requested file after the existing canonical workspace containment policy. */
export const WorkspaceFileExportLive = Layer.succeed(
  WorkspaceFileExport,
  WorkspaceFileExport.of({
    write: Effect.fn("WorkspaceFileExport.write")(function* (
      input: WorkspaceFileExportInput,
      signal: AbortSignal,
    ) {
      return yield* Effect.tryPromise({
        try: async () => {
          const { workspace, target } = await resolveSourceTarget(
            input.workingDirectory,
            input.path,
          );
          await writeFile(target, input.content, { signal });
          return {
            path: relative(workspace, target).split(sep).join("/"),
            bytes: input.content.byteLength,
          };
        },
        catch: (cause) =>
          new WorkspaceFileExportError({
            message: cause instanceof Error ? cause.message : String(cause),
          }),
      });
    }),
  }),
);
