import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeFileSystem, NodePath } from "@effect/platform-node-shared";
import { Effect, Layer } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { defaultApplicationState } from "../../../src/contracts/application/application-data";
import {
  CAKE_CHAT_SESSION_ID,
  SESSION_ASSISTANT_ID,
} from "../../../src/contracts/cake-chats/cake-chat-identity";
import {
  decodeArtifactLineageId,
  decodeArtifactRevisionNumber,
  type ArtifactLinkTarget,
} from "../../../src/contracts/artifacts/artifact-lineage";
import * as artifacts from "../../../src/domain/artifacts/artifacts";
import * as workflows from "../../../src/domain/artifacts/artifactWorkflows";
import { projectChatSessionId } from "../../../src/domain/cake-chats/cakeChatLocations";
import { ProjectAccess } from "../../../src/services/projects/ProjectAccess";
import { makeProjectAccessLive } from "../../../src/services/projects/ProjectAccessLive";
import { ApplicationState } from "../../../src/services/storage/ApplicationState";
import { makeArtifactStorageLive } from "../../../src/services/storage/ArtifactStorageLive";
import { SessionFamilyStorage } from "../../../src/services/storage/SessionFamilyStorage";
import { ManagedWorktrees } from "../../../src/services/worktrees/ManagedWorktrees";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const projectPath = "/registered-project";
const projectChatId = projectChatSessionId(projectPath);
const id = decodeArtifactLineageId("library-report");
const pinned = { mode: "pinned", revision: decodeArtifactRevisionNumber(1) } as const;
const following = { mode: "follow-latest" } as const;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "cake-artifact-chat-links-"));
  roots.push(root);
  const state = {
    ...defaultApplicationState(),
    projects: [{ path: projectPath, name: "Project", addedAt: "", lastOpenedAt: "" }],
  };
  const application = Layer.mock(ApplicationState, { snapshot: () => state });
  const access = makeProjectAccessLive({
    projectSessionDirectory: join(root, "sessions"),
    resolvedProjectSessionDirectory: join(root, "resolved"),
  }).pipe(
    Layer.provide(
      Layer.merge(application, Layer.mock(ManagedWorktrees, { records: () => Effect.succeed([]) })),
    ),
  );
  const storage = () =>
    makeArtifactStorageLive(join(root, "artifacts")).pipe(
      Layer.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer)),
    );
  const families = Layer.mock(SessionFamilyStorage, {
    withMemberLock: (_sessionId, effect) => effect,
    familyForMember: (sessionId) =>
      Effect.succeed(
        sessionId === "member"
          ? {
              familyId: "family",
              parentSessionId: "member",
              projectPath,
              workingDirectory: projectPath,
              createdAt: "2026-01-01T00:00:00.000Z",
              children: [],
            }
          : undefined,
      ),
  });
  return { state, storage, layer: Layer.mergeAll(application, access, storage(), families) };
}

const seed = workflows.create({
  sessionId: "author",
  lineageId: id,
  workingDirectory: projectPath,
  snapshot: {
    protocol: "cake.artifact/v1",
    id,
    sessionId: "author",
    revision: 1,
    kind: "markdown",
    payload: { markdown: "Existing library report" },
    fallback: { markdown: "Existing library report" },
  },
});

describe("Artifact Library durable chat links", () => {
  it.each([projectChatId, CAKE_CHAT_SESSION_ID, SESSION_ASSISTANT_ID])(
    "links, reloads, pins, follows and unlinks %s without a Project Session file",
    async (sessionId) => {
      const f = await fixture();
      await Effect.runPromise(
        Effect.gen(function* () {
          const access = yield* ProjectAccess;
          yield* access.allow(projectPath);
          // Reproduce the failing lookup at the real ProjectAccess boundary: Durable
          // identities have no Pi JSONL file, even for a selected, registered project.
          const missing = yield* access.resolveSessionWorkingDirectory(sessionId).pipe(Effect.flip);
          expect(missing.message).toBe(`Cake could not find session ${sessionId}`);
          yield* seed;
          const target = { type: "session", sessionId } as const;
          const input = { sessionId, lineageId: id, target };
          const linked = yield* artifacts.link({ ...input, selection: following });
          expect(linked.target).toEqual(target);
          expect((yield* artifacts.detail(id)).links).toContainEqual(linked);
          expect((yield* artifacts.listEffective(sessionId))[0]?.link).toEqual(linked);

          yield* artifacts.setSelection({ ...input, selection: pinned });
          const reloaded = yield* artifacts.detail(id).pipe(Effect.provide(f.storage()));
          expect(
            reloaded.links.find(
              (link) => link.target.type === "session" && link.target.sessionId === sessionId,
            )?.selection,
          ).toEqual(pinned);
          yield* artifacts.setSelection({ ...input, selection: following });
          expect((yield* artifacts.listEffective(sessionId))[0]?.link.selection).toEqual(following);
          yield* artifacts.unlink(input);
          expect(yield* artifacts.listEffective(sessionId)).toEqual([]);
          const afterUnlink = yield* artifacts.detail(id).pipe(Effect.provide(f.storage()));
          expect(afterUnlink.links.map((link) => link.target)).toEqual([
            { type: "session", sessionId: "author" },
          ]);
        }).pipe(Effect.provide(f.layer)),
      );
    },
  );

  it("preserves ordinary session and legitimate family links", async () => {
    const f = await fixture();
    await Effect.runPromise(
      Effect.gen(function* () {
        const access = yield* ProjectAccess;
        yield* access.allow(projectPath);
        yield* seed;
        for (const [sessionId, target] of [
          ["ordinary", { type: "session", sessionId: "ordinary" }],
          ["member", { type: "family", familyId: "family" }],
        ] satisfies Array<[string, ArtifactLinkTarget]>) {
          yield* access.rememberSessionLocation(projectPath, sessionId);
          const input = { sessionId, lineageId: id, target };
          expect((yield* artifacts.link({ ...input, selection: following })).target).toEqual(
            target,
          );
          yield* artifacts.setSelection({ ...input, selection: pinned });
          expect((yield* artifacts.listEffective(sessionId))[0]?.link.selection).toEqual(pinned);
          yield* artifacts.unlink(input);
          expect(yield* artifacts.listEffective(sessionId)).toEqual([]);
        }
      }).pipe(Effect.provide(f.layer)),
    );
  });

  it("rejects mismatches, fake/removed/revoked projects, invalid sessions and foreign families on every mutation", async () => {
    const f = await fixture();
    await Effect.runPromise(
      Effect.gen(function* () {
        const access = yield* ProjectAccess;
        yield* access.allow(projectPath);
        yield* access.rememberSessionLocation(projectPath, "ordinary");
        yield* seed;
        const direct = (sessionId: string): ArtifactLinkTarget => ({ type: "session", sessionId });
        const invalid: Array<[string, ArtifactLinkTarget]> = [
          [projectChatId, direct(CAKE_CHAT_SESSION_ID)],
          [CAKE_CHAT_SESSION_ID, direct(projectChatId)],
          [projectChatId, { type: "family", familyId: "family" }],
          [CAKE_CHAT_SESSION_ID, { type: "family", familyId: "family" }],
          [projectChatSessionId("/unregistered"), direct(projectChatSessionId("/unregistered"))],
          ["project-chat:invalid", direct("project-chat:invalid")],
          ["missing-session", direct("missing-session")],
          ["ordinary", direct(projectChatId)],
          ["ordinary", { type: "family", familyId: "foreign" }],
        ];
        for (const [sessionId, target] of invalid) {
          const input = { sessionId, target, lineageId: id, selection: following };
          for (const operation of [
            artifacts.link(input),
            artifacts.setSelection(input),
            artifacts.unlink(input),
          ]) {
            expect((yield* operation.pipe(Effect.flip))._tag).toBe("ArtifactError");
          }
        }
        const input = {
          sessionId: projectChatId,
          target: direct(projectChatId),
          lineageId: id,
          selection: following,
        };
        yield* artifacts.link(input);
        yield* access.revoke(projectPath);
        for (const operation of [
          artifacts.link(input),
          artifacts.setSelection(input),
          artifacts.unlink(input),
        ]) {
          expect(yield* operation.pipe(Effect.flip)).toMatchObject({
            _tag: "ArtifactError",
            message: "Project path was not selected by the user",
          });
        }
        yield* access.allow(projectPath);
        f.state.projects.length = 0;
        for (const operation of [
          artifacts.link(input),
          artifacts.setSelection(input),
          artifacts.unlink(input),
        ]) {
          expect(yield* operation.pipe(Effect.flip)).toMatchObject({
            _tag: "ArtifactError",
            message: "Project Chat belongs to no registered project",
          });
        }
        expect((yield* artifacts.detail(id)).links.map((link) => link.target)).toEqual([
          direct("author"),
          direct(projectChatId),
        ]);
      }).pipe(Effect.provide(f.layer)),
    );
  });
});
