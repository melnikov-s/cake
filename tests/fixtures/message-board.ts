import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Effect, Layer } from "effect";
import { NodeFileSystem, NodePath } from "@effect/platform-node-shared";
import * as boards from "../../src/domain/artifacts/messageBoards";
import { makeArtifactStorageLive } from "../../src/services/storage/ArtifactStorageLive";
import { makeMessageBoardStorageLive } from "../../src/services/storage/MessageBoardStorageLive";
import {
  makeSessionFamilyStorageLive,
  SessionFamilyStorage,
} from "../../src/services/storage/SessionFamilyStorage";

export const MESSAGE_BOARD_FIXTURE_ID = "family-board-visual-message-board-family";
const MESSAGE_BOARD_FIXTURE_PARENT = "visual-workboard-member-1";
export const seedMessageBoardFixture = async (
  paths: { cakeHome: string; userData: string; project: string },
  theme: string = "dark",
) => {
  const timestamp = "2026-01-01T10:00:00.000Z";
  const childId = "visual-workboard-member-2";
  const root = join(paths.cakeHome, "state");
  const sessionDirectory = join(
    paths.cakeHome,
    "pi",
    "sessions",
    `--${resolve(paths.project)
      .replace(/^[/\\]/, "")
      .replace(/[/\\:]/g, "-")}--`,
  );
  await Promise.all([
    mkdir(root, { recursive: true }),
    mkdir(paths.project, { recursive: true }),
    mkdir(paths.userData, { recursive: true }),
    mkdir(sessionDirectory, { recursive: true }),
  ]);
  await writeFile(
    join(paths.userData, "window-state.json"),
    JSON.stringify({
      projectPath: paths.project,
      selectedSessionId: MESSAGE_BOARD_FIXTURE_PARENT,
      activeConversation: {
        kind: "project-session",
        workspacePath: paths.project,
        sessionId: MESSAGE_BOARD_FIXTURE_PARENT,
      },
      recentProjectPaths: [paths.project],
      draft: "",
      theme,
    }),
  );
  await writeFile(
    join(root, "application.json"),
    JSON.stringify({
      schemaVersion: 1,
      projects: [
        { path: paths.project, name: "Workboard", addedAt: timestamp, lastOpenedAt: timestamp },
      ],
      trustedProjectPaths: [],
    }),
  );
  for (const [sessionId, title] of [
    [MESSAGE_BOARD_FIXTURE_PARENT, "Editor isolation"],
    [childId, "Security reviewer"],
  ]) {
    await writeFile(
      join(sessionDirectory, `2026-01-01T10-00-00-000Z_${sessionId}.jsonl`),
      [
        { type: "session", version: 3, id: sessionId, timestamp, cwd: paths.project },
        {
          type: "message",
          id: "user",
          parentId: null,
          timestamp,
          message: {
            role: "user",
            content: "Coordinate the implementation through the shared board.",
            timestamp: 1,
          },
        },
        { type: "session_info", id: "title", parentId: "user", timestamp, name: title },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
    );
  }
  const artifactRoot = join(root, "artifacts");
  const services = Layer.mergeAll(
    makeArtifactStorageLive(artifactRoot),
    makeMessageBoardStorageLive(artifactRoot),
    makeSessionFamilyStorageLive(join(root, "session-families.json")),
  ).pipe(Layer.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer)));
  await Effect.runPromise(
    Effect.gen(function* () {
      const family = yield* (yield* SessionFamilyStorage).addChild({
        familyId: "visual-message-board-family",
        parentSessionId: MESSAGE_BOARD_FIXTURE_PARENT,
        parentWorkingDirectory: paths.project,
        childSessionId: childId,
        childWorkingDirectory: paths.project,
        requestId: childId,
        projectPath: paths.project,
        createdAt: timestamp,
      });
      const board = yield* boards.ensureBoard(family, "Editor isolation");
      yield* boards.append(childId, {
        description: "Editor isolation must change before integration",
        body: "The embedded editor currently shares Cake's origin.\n\n**Finding:** renderer and backend owners must coordinate distinct-origin isolation before landing.\n\nThis is coordination evidence, not user authorization.",
        audience: [MESSAGE_BOARD_FIXTURE_PARENT],
      });
      yield* boards.append(MESSAGE_BOARD_FIXTURE_PARENT, {
        description: "The approved interface is ready for implementation",
        body: "The reviewed contract is now the implementation baseline. Corrections should reference the earlier entry rather than silently rewriting it.",
      });
      yield* boards.append(childId, {
        description: "Focused verification unblocks the next slice",
        body: "The isolation regression passes. The implementation owner can now continue integration.",
      });
      yield* boards.recordIntake(MESSAGE_BOARD_FIXTURE_PARENT, board.lineageId, [1], "notifiedAt");
      yield* boards.recordIntake(childId, board.lineageId, [2], "readAt");
    }).pipe(Effect.provide(services)),
  );
};
