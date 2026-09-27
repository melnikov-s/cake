import { it } from "@effect/vitest";
import { Effect } from "effect";
import { describe, expect } from "vitest";
import { ClientWorkspaces } from "../../../../src/services/clients/ClientWorkspaces";
import { ClientWorkspacesLive } from "../../../../src/services/clients/ClientWorkspacesLive";

describe("ClientWorkspaces", () => {
  it.effect("client_workspace_cleanup_is_isolated", () =>
    Effect.gen(function* () {
      const workspaces = yield* ClientWorkspaces;
      workspaces.associateWorkspace(7, "/project");
      workspaces.associateWorkspace(8, "/project");
      workspaces.associateWorkspace(9, "/other");
      workspaces.releaseConnection(7);
      workspaces.releaseConnection(7);
      expect(workspaces.workspaceForConnection(7)).toBeUndefined();
      expect(workspaces.workspaceForConnection(8)).toBe("/project");
      workspaces.associateWorkspace(8, "/new");
      workspaces.forgetWorkspace("/project");
      expect(workspaces.workspaceForConnection(8)).toBe("/new");
      workspaces.associateWorkspace(7, "/new");
      workspaces.forgetWorkspace("/new");
      expect(workspaces.workspaceForConnection(7)).toBeUndefined();
      expect(workspaces.workspaceForConnection(8)).toBeUndefined();
      expect(workspaces.workspaceForConnection(9)).toBe("/other");
    }).pipe(Effect.provide(ClientWorkspacesLive)),
  );

  it.effect("releases transient associations with the backend scope", () =>
    Effect.gen(function* () {
      const workspaces = yield* Effect.scoped(
        Effect.gen(function* () {
          const service = yield* ClientWorkspaces;
          service.associateWorkspace(7, "/project");
          return service;
        }).pipe(Effect.provide(ClientWorkspacesLive)),
      );
      expect(workspaces.workspaceForConnection(7)).toBeUndefined();
    }),
  );
});
