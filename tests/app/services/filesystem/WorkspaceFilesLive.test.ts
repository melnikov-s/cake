import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { Electron } from "../../../../src/services/electron/Electron";
import { makeWorkspaceFilesLive } from "../../../../src/services/filesystem/WorkspaceFilesLive";
import { WorkspaceFiles } from "../../../../src/services/filesystem/WorkspaceFiles";
import { ProjectAccess } from "../../../../src/services/projects/ProjectAccess";

const workspaceFilesLayer = makeWorkspaceFilesLive("/tmp/cake-agent-test").pipe(
  Layer.provide(
    Layer.mergeAll(
      Layer.mock(Electron, {
        sendTo: () => {},
        broadcast: () => {},
        requireRendererConnection: () => Object.assign(Object.create(null), { id: 1 }),
        workspaceForConnection: () => undefined,
        associateWorkspace: () => {},
        forgetWorkspace: () => {},
        windowsForWorkspace: () => [],
        centerTrafficLights: () => {},
      }),
      Layer.mock(ProjectAccess, { isAllowed: () => Effect.succeed(true) }),
    ),
  ),
);

describe("WorkspaceFilesLive", () => {
  it.effect("reads only bounded images contained by the authorized workspace", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => mkdtemp(join(tmpdir(), "cake-workspace-image-"))),
      (root) =>
        Effect.gen(function* () {
          const workspace = join(root, "workspace");
          const outside = join(root, "outside.png");
          yield* Effect.promise(() =>
            mkdir(join(workspace, ".visual-captures"), { recursive: true }),
          );
          yield* Effect.promise(() => writeFile(outside, Buffer.from([9, 8, 7])));
          yield* Effect.promise(() =>
            writeFile(join(workspace, ".visual-captures", "capture.png"), Buffer.from([1, 2, 3])),
          );
          yield* Effect.promise(() =>
            symlink(outside, join(workspace, ".visual-captures", "external.png")),
          );

          const files = yield* WorkspaceFiles;
          const image = yield* files.readImage(1, {
            workspacePath: workspace,
            path: ".visual-captures/capture.png",
          });
          expect(image).toEqual({ data: "AQID", mimeType: "image/png" });

          const escaped = yield* Effect.result(
            files.readImage(1, {
              workspacePath: workspace,
              path: ".visual-captures/external.png",
            }),
          );
          expect(escaped._tag).toBe("Failure");
        }).pipe(Effect.provide(workspaceFilesLayer)),
      (root) => Effect.promise(() => rm(root, { recursive: true, force: true })),
    ),
  );
});
