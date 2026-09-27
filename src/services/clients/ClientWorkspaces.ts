import { Context } from "effect";

/** Transient active Working Directory per trusted transport connection, not authorization. */
export class ClientWorkspaces extends Context.Service<
  ClientWorkspaces,
  {
    readonly workspaceForConnection: (connectionId: number) => string | undefined;
    readonly associateWorkspace: (connectionId: number, workingDirectory: string) => void;
    readonly forgetWorkspace: (workingDirectory: string) => void;
    readonly releaseConnection: (connectionId: number) => void;
  }
>()("cake/services/clients/ClientWorkspaces") {}
