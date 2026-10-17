import { Effect, Option } from "effect";
import { AttachmentUploads } from "../../services/filesystem/AttachmentUploads";
import { ProjectAccess } from "../../services/projects/ProjectAccess";
import { RewordingRequests } from "../../services/projects/RewordingRequests";
import { RendererRequestCoordinator } from "../../services/renderer-requests/RendererRequestCoordinator";
import { Terminal } from "../../services/terminal/Terminal";
import { VsCodeServer } from "../../services/vscode/VsCodeServer";
import { InlineWidgets } from "../../services/widgets/InlineWidgets";
import * as workingDirectoryTerminals from "../terminals/workingDirectoryTerminals";

/** Shared backend-owned inventory for socket loss and native window closure.
 * Native view/browser cleanup stays with the desktop host. Remote hosts may lack these Services. */
export const releaseConnectionResources = Effect.fn("clients.releaseConnectionResources")(
  function* (owner: number) {
    const terminal = yield* Effect.serviceOption(Terminal);
    const access = yield* Effect.serviceOption(ProjectAccess);
    const rewording = yield* Effect.serviceOption(RewordingRequests);
    const requests = yield* Effect.serviceOption(RendererRequestCoordinator);
    const vscode = yield* Effect.serviceOption(VsCodeServer);
    const uploads = yield* Effect.serviceOption(AttachmentUploads);
    const widgets = yield* Effect.serviceOption(InlineWidgets);
    yield* Effect.all(
      [
        Option.isSome(terminal)
          ? workingDirectoryTerminals.closeOwner(owner).pipe(
              Effect.provideService(Terminal, terminal.value),
              Effect.catch((error) =>
                Effect.logWarning("Terminal disconnect cleanup failed", error),
              ),
            )
          : Effect.void,
        Option.isSome(access) ? access.value.clearOwner(owner) : Effect.void,
        Option.isSome(rewording) ? rewording.value.disposeOwner(owner) : Effect.void,
        Option.isSome(requests) ? requests.value.releaseConnection(owner) : Effect.void,
        Option.isSome(vscode) ? vscode.value.releaseConnection(owner) : Effect.void,
        Option.isSome(uploads) ? uploads.value.releaseConnection(owner) : Effect.void,
        Option.isSome(widgets) ? widgets.value.releaseConnection(owner) : Effect.void,
      ],
      { concurrency: "unbounded", discard: true },
    );
  },
);
