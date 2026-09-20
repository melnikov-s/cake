import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import { describe } from "vitest";
import { ArtifactLineageId, ArtifactLink } from "../../../src/domain/artifacts/artifact-lineage";
import { ProjectSessionProjection } from "../../../src/domain/project-sessions/project-session-data";
import { assemble } from "../../../src/domain/project-sessions/projectSessionProjection";
import { ArtifactStorage } from "../../../src/services/storage/ArtifactStorage";
import { ReviewStorage } from "../../../src/services/storage/ReviewStorage";
import { SessionFamilyStorage } from "../../../src/services/storage/SessionFamilyStorage";
import { SubagentCoordinatorLive } from "../../../src/services/subagents/SubagentCoordinator";

const reviewRecord = {
  id: "thread-1",
  workspacePath: "/projects/cake",
  sessionId: "session-1",
  agentSessionId: "discussion-1",
  agentSessionFile: "/discussions/discussion-1.jsonl",
  anchor: {
    path: "src/main.ts",
    view: "message" as const,
    start: { diffLine: 1 },
    end: { diffLine: 1 },
    selectedText: "selection",
    contextBefore: "",
    contextAfter: "",
    diff: "",
  },
  pendingComments: [],
  status: "open" as const,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:01:00.000Z",
};

const artifactLink = Schema.decodeUnknownSync(ArtifactLink)({
  lineageId: "artifact-1",
  target: { type: "family", familyId: "family-1" },
  selection: { mode: "follow-latest" },
  createdAt: "2026-01-01T00:00:00.000Z",
});

const authorities = Layer.mergeAll(
  SubagentCoordinatorLive,
  Layer.mock(ReviewStorage, {
    agentSessionDirectory: () => "/discussions",
    reviewContextPath: () => "/reviews/context.md",
    discussionParentContextPath: () => "/reviews/thread-context.md",
    listDiscussionRecords: () => Effect.succeed([reviewRecord]),
  }),
  Layer.mock(SessionFamilyStorage, {
    familyForMember: () =>
      Effect.succeed({
        familyId: "family-1",
        parentSessionId: "session-1",
        projectPath: "/projects/cake",
        workingDirectory: "/projects/cake",
        createdAt: "2026-01-01T00:00:00.000Z",
        children: [
          {
            sessionId: "session-2",
            parentSessionId: "session-1",
            requestId: "request-1",
            workingDirectory: "/projects/cake-child",
            createdAt: "2026-01-01T00:01:00.000Z",
          },
        ],
      }),
  }),
  Layer.mock(ArtifactStorage, {
    catalog: () =>
      Effect.succeed({
        lineages: [],
        links: [
          artifactLink,
          Schema.decodeUnknownSync(ArtifactLink)({
            lineageId: ArtifactLineageId.make("unrelated"),
            target: { type: "session", sessionId: "another-session" },
            selection: { mode: "follow-latest" },
            createdAt: "2026-01-01T00:00:00.000Z",
          }),
        ],
      }),
  }),
);

describe("ProjectSessionProjection", () => {
  it.effect("assembles focused authority references and validates the boundary projection", () =>
    Effect.gen(function* () {
      const projection = yield* assemble({
        sessionId: "session-1",
        location: {
          projectPath: "/projects/cake",
          projectName: "Cake",
          workingDirectory: "/projects/cake",
          sessionDirectory: "/sessions",
          resolvedSessionDirectory: "/resolved-sessions",
        },
        resolved: false,
        unread: true,
      });

      assert.deepEqual(projection.primaryConversation, { sessionId: "session-1" });
      assert.deepEqual(projection.discussionSessions, [
        {
          threadId: "thread-1",
          sessionId: "discussion-1",
          status: "open",
          anchor: "message",
        },
      ]);
      assert.deepEqual(projection.reviewThreads, [
        {
          threadId: "thread-1",
          status: "open",
          anchor: "message",
          updatedAt: reviewRecord.updatedAt,
        },
      ]);
      assert.deepEqual(projection.artifactLinks, [artifactLink]);
      assert.deepEqual(projection.family, {
        familyId: "family-1",
        rootProjectSessionId: "session-1",
        childProjectSessionIds: ["session-2"],
        depth: 0,
      });

      // Effect RPC uses this Schema at the main-to-renderer transport boundary.
      const encoded = yield* Schema.encodeEffect(ProjectSessionProjection)(projection);
      const decoded = yield* Schema.decodeUnknownEffect(ProjectSessionProjection)(encoded);
      assert.deepEqual(decoded, projection);
    }).pipe(Effect.provide(authorities)),
  );
});
