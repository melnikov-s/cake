import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { describe } from "vitest";
import { admitTurn } from "../../../src/domain/session-families/sessionFamilies";
import { encodeCrossSessionMessage } from "../../../src/domain/conversations/cross-session-coordination";
import { SessionFamilyStorage } from "../../../src/services/storage/SessionFamilyStorage";
import { SessionArchiveStorage } from "../../../src/services/storage/SessionArchiveStorage";
import { familyStorageHarness } from "../helpers/familyStorageHarness";

const reservation = {
  familyId: "family",
  parentSessionId: "parent",
  parentWorkingDirectory: "/worktree",
  childSessionId: "child",
  childWorkingDirectory: "/worktree",
  requestId: "request",
  projectPath: "/project",
  createdAt: "2026-09-05",
};
const archiveLocation = { cwd: "/worktree", activeRoot: "/active", resolvedRoot: "/resolved" };
const layer = () =>
  Layer.mergeAll(
    familyStorageHarness().layer,
    Layer.mock(SessionArchiveStorage, { locate: () => Effect.succeed("active" as const) }),
  );
const message = (senderSessionId: string, expectsResponse: boolean, generatedNotice = false) =>
  encodeCrossSessionMessage("Coordinate this", {
    version: 1,
    messageId: crypto.randomUUID(),
    threadId: crypto.randomUUID(),
    sequence: 1,
    expectsResponse,
    ...(generatedNotice ? { generatedNotice: true } : null),
    sender: {
      sessionId: senderSessionId,
      title: "Sender",
      kind: "project-session",
    },
  });

describe("Session Family lifecycle", () => {
  it.effect("records recursive child requests for the actual sender", () =>
    Effect.gen(function* () {
      const storage = yield* SessionFamilyStorage;
      yield* storage.addChild(reservation);
      yield* storage.addChild({
        ...reservation,
        parentSessionId: "child",
        parentWorkingDirectory: "/worktree",
        childSessionId: "grandchild",
        requestId: "grandchild-request",
      });
      yield* admitTurn(
        "grandchild",
        archiveLocation,
        { turnId: "grandchild-turn", text: message("child", true) },
        Effect.void,
      );
      assert.deepEqual(
        (yield* storage.state()).turns.map((turn) => ({
          sessionId: turn.sessionId,
          senderSessionId: turn.senderSessionId,
          turnId: turn.turnId,
          expectsResponse: turn.expectsResponse,
        })),
        [
          {
            sessionId: "grandchild",
            senderSessionId: "child",
            turnId: "grandchild-turn",
            expectsResponse: true,
          },
        ],
      );
    }).pipe(Effect.provide(layer())),
  );

  it.effect("records only accepted family messages and ignores generated notices", () =>
    Effect.gen(function* () {
      const storage = yield* SessionFamilyStorage;
      yield* storage.addChild(reservation);
      yield* admitTurn(
        "child",
        archiveLocation,
        { turnId: "request-turn", text: message("parent", true) },
        Effect.void,
      );
      yield* admitTurn(
        "child",
        archiveLocation,
        { turnId: "informational-turn", text: message("parent", false) },
        Effect.void,
      );
      yield* admitTurn(
        "child",
        archiveLocation,
        { turnId: "notice-turn", text: message("parent", false, true) },
        Effect.void,
      );
      assert.deepEqual(
        (yield* storage.state()).turns.map((turn) => [turn.turnId, turn.expectsResponse]),
        [
          ["request-turn", true],
          ["informational-turn", false],
        ],
      );
      yield* storage.settleTurn("informational-turn", "complete");
      assert.deepEqual(
        (yield* storage.state()).turns.map((turn) => turn.turnId),
        ["request-turn"],
      );
    }).pipe(Effect.provide(layer())),
  );

  it.effect("does not retain a response obligation when Pi rejects acceptance", () =>
    Effect.gen(function* () {
      const storage = yield* SessionFamilyStorage;
      yield* storage.addChild(reservation);
      yield* Effect.exit(
        admitTurn(
          "child",
          archiveLocation,
          { turnId: "rejected-turn", text: message("parent", true) },
          Effect.die("rejected"),
        ),
      );
      assert.deepEqual((yield* storage.state()).turns, []);
    }).pipe(Effect.provide(layer())),
  );

  it.effect("rejects admission while a failed transition awaits recovery", () =>
    Effect.gen(function* () {
      const storage = yield* SessionFamilyStorage;
      yield* storage.addChild(reservation);
      yield* storage.beginTransition("parent", false);
      const error = yield* Effect.flip(
        admitTurn(
          "child",
          archiveLocation,
          { turnId: "turn", text: "work" },
          Effect.die("Must not accept"),
        ),
      );
      assert.match(error.message, /incomplete lifecycle/);
    }).pipe(Effect.provide(layer())),
  );
});
