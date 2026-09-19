import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { describe } from "vitest";
import {
  DrawBoardId,
  DrawBoardTitle,
  DrawSessionId,
  type DrawBoardError,
} from "../../../src/domain/draw/draw-board-data";
import * as drawBoards from "../../../src/domain/draw/drawBoards";
import { DrawBoardStorage } from "../../../src/services/storage/DrawBoardStorage";
import { SessionArchiveStorage } from "../../../src/services/storage/SessionArchiveStorage";
import {
  SessionFamilyStorage,
  type SessionFamily,
} from "../../../src/services/storage/SessionFamilyStorage";

const sessionId = DrawSessionId.make("resolved-session");
const boardId = DrawBoardId.make("00000000-0000-4000-8000-000000000001");
const title = DrawBoardTitle.make("Read-only board");

const resolvedMetadata = (resolvedSessionId: string) => ({
  version: 1 as const,
  sessionId: resolvedSessionId,
  projectPath: "/project",
  projectName: "Project",
  workingDirectory: "/project",
  activeRoot: "/sessions",
  resolvedRoot: "/resolved",
  createdAt: "2026-01-01T00:00:00.000Z",
  modifiedAt: "2026-01-01T00:00:00.000Z",
});

const readOnlyLayer = (
  family: SessionFamily | undefined,
  onResolvedLookup: (sessionId: string) => void = () => undefined,
) =>
  Layer.mergeAll(
    Layer.mock(SessionFamilyStorage, {
      familyForMember: () => Effect.succeed(family),
    }),
    Layer.mock(SessionArchiveStorage, {
      resolvedProjectEntry: (targetSessionId) =>
        Effect.sync(() => {
          onResolvedLookup(targetSessionId);
          return resolvedMetadata(targetSessionId);
        }),
    }),
    Layer.mock(DrawBoardStorage, {
      create: () => Effect.die("storage must not be called"),
      save: () => Effect.die("storage must not be called"),
      rename: () => Effect.die("storage must not be called"),
      delete: () => Effect.die("storage must not be called"),
    }),
  );

const expectReadOnly = <A, R>(effect: Effect.Effect<A, DrawBoardError, R>) =>
  effect.pipe(
    Effect.flip,
    Effect.tap((failure) =>
      Effect.sync(() => {
        assert.equal(failure.code, "read-only");
      }),
    ),
    Effect.asVoid,
  );

describe("DrawBoards", () => {
  it.effect("rejects every board mutation for a resolved session", () =>
    Effect.forEach(
      [
        drawBoards.create({ sessionId, title }),
        drawBoards.save({ sessionId, boardId, expectedRevision: 0, snapshot: {} }),
        drawBoards.rename({ sessionId, boardId, title }),
        drawBoards.deleteBoard({ sessionId, boardId }),
      ],
      expectReadOnly,
      { discard: true },
    ).pipe(Effect.provide(readOnlyLayer(undefined))),
  );

  it.effect("checks the resolved family parent for a child board mutation", () => {
    const lookedUp: string[] = [];
    const family: SessionFamily = {
      familyId: "family-1",
      parentSessionId: "parent-session",
      projectPath: "/project",
      workingDirectory: "/project",
      createdAt: "2026-01-01T00:00:00.000Z",
      children: [
        {
          sessionId,
          parentSessionId: "parent-session",
          requestId: "request-1",
          workingDirectory: "/project",
          createdAt: "2026-01-01T00:00:01.000Z",
        },
      ],
    };
    return expectReadOnly(drawBoards.create({ sessionId, title })).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          assert.deepEqual(lookedUp, ["parent-session"]);
        }),
      ),
      Effect.provide(readOnlyLayer(family, (id) => lookedUp.push(id))),
    );
  });
});
