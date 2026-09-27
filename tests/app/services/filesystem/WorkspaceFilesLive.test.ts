import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { makeWorkspaceFilesLive } from "../../../../src/services/filesystem/WorkspaceFilesLive";
import { WorkspaceFiles } from "../../../../src/services/filesystem/WorkspaceFiles";
import { ProjectAccess } from "../../../../src/services/projects/ProjectAccess";

const workspaceFilesLayer = makeWorkspaceFilesLive("/tmp/cake-agent-test").pipe(
  Layer.provide(
    Layer.mergeAll(Layer.mock(ProjectAccess, { isAllowed: () => Effect.succeed(true) })),
  ),
);

describe("WorkspaceFilesLive", () => {
  it.effect("rejects unselected workspaces before suggesting or reading content", () =>
    Effect.gen(function* () {
      const files = yield* WorkspaceFiles;
      for (const result of [
        files.suggestFiles(1, { workspacePath: "/private", prefix: "a" }).pipe(Effect.asVoid),
        files.readFile(1, { workspacePath: "/private", path: "secret.txt" }).pipe(Effect.asVoid),
        files.readImage(1, { workspacePath: "/private", path: "secret.png" }).pipe(Effect.asVoid),
      ]) {
        const failure = yield* Effect.result(result);
        expect(failure._tag).toBe("Failure");
        if (failure._tag === "Failure")
          expect(failure.failure).toMatchObject({ operation: "authorizeWorkingDirectory" });
      }
    }).pipe(
      Effect.provide(
        makeWorkspaceFilesLive("/agent").pipe(
          Layer.provide(Layer.mock(ProjectAccess, { isAllowed: () => Effect.succeed(false) })),
        ),
      ),
    ),
  );
  it.effect("reads in-workspace files whose names start with two dots", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => mkdtemp(join(tmpdir(), "cake-workspace-dot-prefix-"))),
      (workspace) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => writeFile(join(workspace, "..notes.txt"), "workspace text"));
          yield* Effect.promise(() =>
            writeFile(join(workspace, "..preview.png"), Buffer.from([1, 2])),
          );
          const files = yield* WorkspaceFiles;
          expect(
            yield* files.readFile(1, { workspacePath: workspace, path: "..notes.txt" }),
          ).toEqual({ content: "workspace text" });
          expect(
            yield* files.readImage(1, { workspacePath: workspace, path: "..preview.png" }),
          ).toEqual({ data: "AQI=", mimeType: "image/png" });
        }).pipe(Effect.provide(workspaceFilesLayer)),
      (workspace) => Effect.promise(() => rm(workspace, { recursive: true, force: true })),
    ),
  );
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
