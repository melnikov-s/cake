import { Effect } from "effect";
import { setVscodeServerPath } from "./application";
import { VsCodeServer, VsCodeServerError } from "../services/vscode/VsCodeServer";

/** Persists the selected binary and then refreshes the concrete server projection. */
export const setServerPath = Effect.fn("EmbeddedEditor.setServerPath")(function* (
  path: string | undefined,
) {
  const server = yield* VsCodeServer;
  const state = yield* setVscodeServerPath(path).pipe(
    Effect.mapError(
      (error) =>
        new VsCodeServerError({
          operation: "setServerPath",
          message: error instanceof Error ? error.message : String(error),
        }),
    ),
  );
  yield* server.refreshStatus();
  return state;
});
