import { Effect, Layer } from "effect";
import { ClientWorkspaces } from "./ClientWorkspaces";

/** One backend-scoped authority shared by domain operations and all host adapters.
 * No persistence; synchronous assignments are last-write-wins per connection.
 */
export const ClientWorkspacesLive = Layer.effect(
  ClientWorkspaces,
  Effect.gen(function* () {
    const workspaces = new Map<number, string>();
    yield* Effect.addFinalizer(() => Effect.sync(() => workspaces.clear()));
    return ClientWorkspaces.of({
      workspaceForConnection: (connectionId) => workspaces.get(connectionId),
      associateWorkspace: (connectionId, workingDirectory) => {
        workspaces.set(connectionId, workingDirectory);
      },
      forgetWorkspace: (workingDirectory) => {
        for (const [connectionId, current] of workspaces)
          if (current === workingDirectory) workspaces.delete(connectionId);
      },
      releaseConnection: (connectionId) => {
        workspaces.delete(connectionId);
      },
    });
  }),
);
