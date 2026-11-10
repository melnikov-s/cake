import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { makeWorkspaceFilesLive } from "../../../../src/services/filesystem/WorkspaceFilesLive";
import { WorkspaceFiles } from "../../../../src/services/filesystem/WorkspaceFiles";
import { ProjectAccess } from "../../../../src/services/projects/ProjectAccess";
import {
  CAKE_CHAT_SESSION_ID,
  cakeChatSideChatSessionId,
} from "../../../../src/contracts/cake-chats/cake-chat-identity";
import { projectChatSessionId } from "../../../../src/domain/cake-chats/cakeChatLocations";
import {
  cakeChatScratchDirectory,
  cakeChatSessionDirectory,
} from "../../../../src/services/pi-durable/cake-chat-directories";

const filesLayer = (cakeChatDirectory: string) =>
  makeWorkspaceFilesLive("/tmp/cake-agent-test", cakeChatDirectory).pipe(
    Layer.provide(Layer.mock(ProjectAccess, { isAllowed: () => Effect.succeed(true) })),
  );
const workspaceFilesLayer = filesLayer("/tmp/cake-chat-test");

describe("WorkspaceFilesLive", () => {
  it.effect("rejects unselected workspaces before suggesting or reading text content", () =>
    Effect.gen(function* () {
      const files = yield* WorkspaceFiles;
      for (const result of [
        files.suggestFiles(1, { workspacePath: "/private", prefix: "a" }).pipe(Effect.asVoid),
        files.readFile(1, { workspacePath: "/private", path: "secret.txt" }).pipe(Effect.asVoid),
      ]) {
        const failure = yield* Effect.result(result);
        expect(failure._tag).toBe("Failure");
        if (failure._tag === "Failure")
          expect(failure.failure).toMatchObject({ operation: "authorizeWorkingDirectory" });
      }
    }).pipe(
      Effect.provide(
        makeWorkspaceFilesLive("/agent", "/cake-chat").pipe(
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
  it.effect(
    "reads bounded images from any local path, resolving relative paths against the workspace",
    () =>
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
            const read = (path: string, workspacePath: string | undefined = workspace) =>
              files.readImage(1, { ...(workspacePath ? { workspacePath } : null), path });
            const image = yield* read(".visual-captures/capture.png");
            expect(image).toEqual({ data: "AQID", mimeType: "image/png" });
            expect(yield* read(join(workspace, ".visual-captures", "capture.png"))).toEqual(image);

            // Absolute /tmp-style paths, parent escapes and symlinks need no project containment.
            const external = { data: "CQgH", mimeType: "image/png" };
            for (const path of [outside, "../outside.png", ".visual-captures/external.png"])
              expect(yield* read(path), path).toEqual(external);
            // Global Cake Chat has no Working Directory; absolute paths still resolve.
            expect(yield* read(outside, undefined)).toEqual(external);
            // Workspace authorization does not gate image reads.
            expect(yield* read(outside, "/not-selected")).toEqual(external);

            // SVG renders through <img>, where browsers run no scripts.
            yield* Effect.promise(() => writeFile(join(workspace, "drawing.svg"), "<svg/>"));
            expect(yield* read("drawing.svg")).toEqual({
              data: Buffer.from("<svg/>").toString("base64"),
              mimeType: "image/svg+xml",
            });
            yield* Effect.promise(() => writeFile(join(workspace, "notes.txt"), "text"));
            yield* Effect.promise(() =>
              writeFile(join(workspace, "huge.png"), Buffer.alloc(8 * 1_024 * 1_024 + 1)),
            );
            yield* Effect.promise(() => mkdir(join(workspace, "folder.png")));
            for (const [path, message] of [
              ["missing.png", `File not found: ${join(workspace, "missing.png")}`],
              [
                join(root, "missing", "shot.png"),
                `File not found: ${join(root, "missing", "shot.png")}`,
              ],
              ["notes.txt", "Unsupported image type: .txt"],
              ["huge.png", "Image is larger than 8 MB"],
              ["folder.png", "Not a file"],
            ] as const) {
              const failure = yield* Effect.result(read(path));
              expect(failure, path).toMatchObject({
                _tag: "Failure",
                failure: { operation: "readImage", message },
              });
            }
          }).pipe(Effect.provide(workspaceFilesLayer)),
        (root) => Effect.promise(() => rm(root, { recursive: true, force: true })),
      ),
  );
  it.effect(
    "resolves relative images against the authoring chat's scratch directory before its project",
    () =>
      Effect.acquireUseRelease(
        Effect.promise(() => mkdtemp(join(tmpdir(), "cake-chat-image-"))),
        (root) =>
          Effect.gen(function* () {
            const globalChat = join(root, "pi", "global-chat");
            const project = join(root, "project");
            const projectChatId = projectChatSessionId(project);
            const projectScratch = cakeChatScratchDirectory(
              cakeChatSessionDirectory(globalChat, projectChatId)!,
            );
            const globalScratch = cakeChatScratchDirectory(globalChat);
            for (const directory of [join(projectScratch, "pgj"), globalScratch, project])
              yield* Effect.promise(() => mkdir(directory, { recursive: true }));
            yield* Effect.promise(() =>
              writeFile(join(projectScratch, "pgj", "top-light.png"), Buffer.from([1])),
            );
            yield* Effect.promise(() => writeFile(join(project, "repo.png"), Buffer.from([2])));
            yield* Effect.promise(() =>
              writeFile(join(globalScratch, "shot.png"), Buffer.from([3])),
            );
            const files = yield* WorkspaceFiles;

            // Project Chat: the renderer knows the project root; the scratch dir is derived.
            const projectChat = { sessionId: projectChatId, workspacePath: project };
            expect(
              yield* files.readImage(1, { ...projectChat, path: "pgj/top-light.png" }),
            ).toEqual({ data: "AQ==", mimeType: "image/png" });
            expect(yield* files.readImage(1, { ...projectChat, path: "repo.png" })).toEqual({
              data: "Ag==",
              mimeType: "image/png",
            });
            // Its side chats start in the same scratch directory.
            expect(
              yield* files.readImage(1, {
                sessionId: cakeChatSideChatSessionId(4, projectChatId),
                workspacePath: project,
                path: "pgj/top-light.png",
              }),
            ).toEqual({ data: "AQ==", mimeType: "image/png" });
            // Global Cake Chat has no project; its scratch directory comes first.
            expect(
              yield* files.readImage(1, { sessionId: CAKE_CHAT_SESSION_ID, path: "shot.png" }),
            ).toEqual({ data: "Aw==", mimeType: "image/png" });

            // A miss names every absolute path tried, in order.
            const failure = yield* Effect.result(
              files.readImage(1, { ...projectChat, path: "pgj/missing.png" }),
            );
            expect(failure).toMatchObject({
              _tag: "Failure",
              failure: {
                operation: "readImage",
                message: `File not found. Tried:\n${join(projectScratch, "pgj", "missing.png")}\n${join(project, "pgj", "missing.png")}`,
              },
            });
          }).pipe(Effect.provide(filesLayer(join(root, "pi", "global-chat")))),
        (root) => Effect.promise(() => rm(root, { recursive: true, force: true })),
      ),
  );
  it.effect("resolves Project Session images in its worktree, then the project root", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => mkdtemp(join(tmpdir(), "cake-worktree-image-"))),
      (root) =>
        Effect.gen(function* () {
          const project = join(root, "project");
          const worktree = join(root, "worktrees", "task");
          for (const directory of [join(project, "docs"), join(worktree, "docs")])
            yield* Effect.promise(() => mkdir(directory, { recursive: true }));
          yield* Effect.promise(() => writeFile(join(worktree, "docs", "a.png"), Buffer.from([1])));
          yield* Effect.promise(() => writeFile(join(project, "docs", "a.png"), Buffer.from([2])));
          yield* Effect.promise(() => writeFile(join(project, "docs", "b.png"), Buffer.from([3])));
          const files = yield* WorkspaceFiles;
          const source = {
            sessionId: "0b5e6c1e-0000-4000-8000-000000000000",
            workspacePath: worktree,
            projectPath: project,
          };
          // The worktree wins; files only on the project root (merged, worktree gone) still load.
          expect(yield* files.readImage(1, { ...source, path: "docs/a.png" })).toEqual({
            data: "AQ==",
            mimeType: "image/png",
          });
          expect(yield* files.readImage(1, { ...source, path: "docs/b.png" })).toEqual({
            data: "Aw==",
            mimeType: "image/png",
          });
          // Absolute paths ignore every base.
          expect(
            yield* files.readImage(1, { ...source, path: join(project, "docs", "a.png") }),
          ).toEqual({ data: "Ag==", mimeType: "image/png" });
        }).pipe(Effect.provide(workspaceFilesLayer)),
      (root) => Effect.promise(() => rm(root, { recursive: true, force: true })),
    ),
  );
  it.effect("expands ~ image paths against the home directory", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => mkdtemp(join(homedir(), ".cake-home-image-"))),
      (directory) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => writeFile(join(directory, "shot.png"), Buffer.from([4])));
          const files = yield* WorkspaceFiles;
          expect(
            yield* files.readImage(1, {
              workspacePath: "/elsewhere",
              path: `~/${relative(homedir(), directory)}/shot.png`,
            }),
          ).toEqual({ data: "BA==", mimeType: "image/png" });
        }).pipe(Effect.provide(workspaceFilesLayer)),
      (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
    ),
  );
});
