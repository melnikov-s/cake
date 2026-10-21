import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { WorkspaceFiles } from "../../../../src/services/filesystem/WorkspaceFiles";
import { makeWorkspaceFilesLive } from "../../../../src/services/filesystem/WorkspaceFilesLive";
import { ProjectAccess } from "../../../../src/services/projects/ProjectAccess";
import type { WorkspaceFileError } from "../../../../src/contracts/filesystem/workspace-files-errors";
import type { EditorLocation } from "../../../../src/contracts/editor/editor-location";

const withFiles = (test: (root: string) => Effect.Effect<void, WorkspaceFileError>) =>
  Effect.acquireUseRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), "cake-file-routing-"))),
    test,
    (root) => Effect.promise(() => rm(root, { recursive: true, force: true })),
  );

describe("authorized file location routing", () => {
  it.effect(
    "uses actual selected containment, origins and symlinks rather than project/worktree association or prefixes",
    () =>
      withFiles((root) =>
        Effect.gen(function* () {
          const project = join(root, "project");
          const sibling = join(root, "project-sibling");
          const worktree = join(root, "managed-worktree");
          const nestedWorktree = join(project, "nested-worktree");
          for (const directory of [project, sibling, worktree, nestedWorktree]) {
            yield* Effect.promise(() => mkdir(directory, { recursive: true }));
            yield* Effect.promise(() => writeFile(join(directory, "file.txt"), directory));
          }
          yield* Effect.promise(() => writeFile(join(project, "..notes"), "notes"));
          yield* Effect.promise(() => symlink(sibling, join(project, "outside")));
          yield* Effect.promise(() => symlink(project, join(sibling, "inside")));
          yield* Effect.promise(() => symlink(project, join(root, "project-alias")));
          const range = { start: { line: 1, column: 2 }, end: { line: 3, column: 4 } };
          const files = yield* WorkspaceFiles;
          const route = (
            selected: string,
            origin: string,
            path: string,
            kind: EditorLocation["kind"] = "working-directory",
          ) =>
            files.prepareFileLocation(1, {
              workspacePath: selected,
              originatingDirectory: origin,
              location: { kind, path, view: "changes", base: "HEAD~1", side: "before", range },
            });
          for (const path of [
            "file.txt",
            "..notes",
            "outside/../file.txt",
            join(project, "file.txt"),
          ]) {
            const result = yield* route(project, project, path);
            expect(result).toMatchObject({
              viewer: "vscode",
              location: {
                kind: "working-directory",
                range,
                view: "changes",
                base: "HEAD~1",
                side: "before",
              },
            });
          }
          expect(yield* route(project, sibling, "inside/file.txt")).toMatchObject({
            viewer: "vscode",
            location: { path: "file.txt" },
          });
          expect(yield* route(join(root, "project-alias"), project, "file.txt")).toMatchObject({
            viewer: "vscode",
          });
          expect(yield* route(project, project, "nested-worktree/file.txt")).toMatchObject({
            viewer: "vscode",
          });
          for (const [origin, path, kind] of [
            [project, "../project-sibling/file.txt", "working-directory"],
            [project, "outside/file.txt", "working-directory"],
            [sibling, "file.txt", "working-directory"],
            [worktree, "file.txt", "working-directory"],
            [project, join(sibling, "file.txt"), "absolute-file"],
          ] as const) {
            expect(yield* route(project, origin, path, kind)).toMatchObject({
              viewer: "text",
              content: origin === worktree ? worktree : sibling,
            });
          }
          expect(
            yield* files.prepareFileLocation(1, {
              originatingDirectory: project,
              location: { kind: "working-directory", path: "file.txt" },
            }),
          ).toMatchObject({ viewer: "text", content: project });
          // The same worktree file becomes an editor target only when contained in the selected root.
          expect(yield* route(worktree, worktree, "file.txt")).toMatchObject({
            viewer: "vscode",
            location: { path: "file.txt" },
          });
          expect(yield* route(sibling, project, "file.txt")).toMatchObject({
            viewer: "text",
            content: project,
          });
          expect(
            yield* route(project, project, relative(project, join(sibling, "file.txt"))),
          ).toMatchObject({
            path: yield* Effect.promise(() => realpath(join(sibling, "file.txt"))),
          });
        }).pipe(
          Effect.provide(
            makeWorkspaceFilesLive("/agent").pipe(
              Layer.provide(
                Layer.mock(ProjectAccess, {
                  isAllowed: () => Effect.succeed(true),
                  allowedWorkingDirectories: () =>
                    Effect.succeed([
                      join(root, "project"),
                      join(root, "project-sibling"),
                      join(root, "managed-worktree"),
                    ]),
                }),
              ),
            ),
          ),
        ),
      ),
  );

  it.effect(
    "rejects unauthorized, unavailable, non-text and oversized external targets without broadening access",
    () =>
      withFiles((root) =>
        Effect.gen(function* () {
          const project = join(root, "project");
          const external = join(root, "allowed");
          yield* Effect.promise(() => mkdir(project));
          yield* Effect.promise(() => mkdir(external));
          yield* Effect.promise(() => writeFile(join(root, "secret"), "private"));
          yield* Effect.promise(() => symlink(join(root, "secret"), join(external, "escape")));
          yield* Effect.promise(() => writeFile(join(external, "binary"), Buffer.from([0, 1, 2])));
          yield* Effect.promise(() => writeFile(join(external, "invalid"), Buffer.from([255])));
          yield* Effect.promise(() => writeFile(join(external, "large"), "a".repeat(2_000_001)));
          const files = yield* WorkspaceFiles;
          for (const path of [
            "../secret",
            "../allowed/escape",
            "../allowed/missing",
            "../allowed/binary",
            "../allowed/invalid",
            "../allowed/large",
            "../allowed",
          ]) {
            const result = yield* Effect.result(
              files.prepareFileLocation(1, {
                workspacePath: project,
                originatingDirectory: project,
                location: { kind: "working-directory", path },
              }),
            );
            expect(result._tag).toBe("Failure");
          }
          for (const request of [
            { workspacePath: root, originatingDirectory: project },
            { workspacePath: project, originatingDirectory: root },
          ]) {
            const result = yield* Effect.result(
              files.prepareFileLocation(1, {
                ...request,
                location: { kind: "working-directory", path: "secret" },
              }),
            );
            expect(result).toMatchObject({
              _tag: "Failure",
              failure: { operation: "authorizeWorkingDirectory" },
            });
          }
        }).pipe(
          Effect.provide(
            makeWorkspaceFilesLive("/agent").pipe(
              Layer.provide(
                Layer.mock(ProjectAccess, {
                  isAllowed: (path) =>
                    Effect.succeed(
                      path === join(root, "project") || path === join(root, "allowed"),
                    ),
                  allowedWorkingDirectories: () =>
                    Effect.succeed([join(root, "project"), join(root, "allowed")]),
                }),
              ),
            ),
          ),
        ),
      ),
  );
});
