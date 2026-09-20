import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { describe } from "vitest";
import { ProjectSessionProjection } from "../../../src/domain/project-sessions/project-session-data";
import { assemble } from "../../../src/domain/project-sessions/projectSessionProjection";

describe("ProjectSessionProjection", () => {
  it.effect("assembles the current on-demand overview without focused relationship payloads", () =>
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

      assert.deepEqual(projection, {
        identity: {
          _tag: "ProjectSession",
          sessionId: "session-1",
          projectPath: "/projects/cake",
          workingDirectory: "/projects/cake",
        },
        project: { path: "/projects/cake", name: "Cake" },
        workingDirectory: { path: "/projects/cake" },
        lifecycle: { resolved: false, unread: true },
        primaryConversation: { sessionId: "session-1" },
      });

      const encoded = yield* Schema.encodeEffect(ProjectSessionProjection)(projection);
      const decoded = yield* Schema.decodeUnknownEffect(ProjectSessionProjection)(encoded);
      assert.deepEqual(decoded, projection);
    }),
  );
});
