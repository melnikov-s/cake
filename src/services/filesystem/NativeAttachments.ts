import { Context, type Effect } from "effect";
import type { cakeRpcSuccessSchemas } from "../../contracts/application/cake-rpc-contract";
import type { WorkspaceFileError } from "../../contracts/filesystem/workspace-files-errors";

/** Device-local dialog. Its file paths must never be interpreted by a remote backend. */
export class NativeAttachments extends Context.Service<
  NativeAttachments,
  {
    readonly readSelected: (
      connectionId: number,
      request: { path: string; offset: number },
    ) => Effect.Effect<{ data: string; size: number }, WorkspaceFileError>;
    readonly choose: (
      connectionId: number,
    ) => Effect.Effect<
      (typeof cakeRpcSuccessSchemas)["choose-attachments"]["Type"],
      WorkspaceFileError
    >;
  }
>()("cake/services/filesystem/NativeAttachments") {}
