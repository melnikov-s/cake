import { it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect, vi } from "vitest";
import {
  reconcileInterrupted,
  recoverUncertain,
} from "../../../src/domain/project-sessions/savedDrafts";
import type { SavedDraft } from "../../../src/domain/project-sessions/saved-draft-data";
import { SavedDraftStorage } from "../../../src/services/storage/SavedDraftStorage";
import { CakeSessionRuntimes } from "../../../src/services/pi/CakeSessionRuntimes";
import { ProjectSessionConfiguration } from "../../../src/services/project-sessions/ProjectSessionConfiguration";

const claimed: SavedDraft = {
  sessionId: "00000000-0000-4000-8000-000000000001",
  projectPath: "/project",
  workingDirectory: "/project",
  title: "Task",
  text: "Start work",
  attachments: [],
  labelIds: [],
  resolved: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  modifiedAt: "2026-01-01T00:00:00.000Z",
  revision: 2,
  status: "activating",
};

it.effect("does not release an accepted-but-not-yet-cataloged turn after restart", () =>
  Effect.gen(function* () {
    const release = vi.fn(() => Effect.succeed(claimed));
    const complete = vi.fn(() => Effect.succeed(claimed));
    yield* reconcileInterrupted().pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(SavedDraftStorage, {
            list: () => Effect.succeed([claimed]),
            release,
            complete,
          }),
          Layer.mock(CakeSessionRuntimes, {
            currentStatus: () => Effect.succeed(undefined),
            catalogEntry: () => Effect.succeed(undefined),
          }),
          Layer.succeed(ProjectSessionConfiguration, {
            agentDirectory: "/agent",
            sessionDirectory: "/sessions",
            resolvedSessionDirectory: "/resolved",
          }),
        ),
      ),
    );
    expect(release).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  }),
);

it.effect("a catalog entry with no messages is not proof that the first turn was accepted", () =>
  Effect.gen(function* () {
    const release = vi.fn(() => Effect.succeed(claimed));
    const complete = vi.fn(() => Effect.succeed(claimed));
    yield* reconcileInterrupted().pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(SavedDraftStorage, {
            list: () => Effect.succeed([claimed]),
            release,
            complete,
          }),
          Layer.mock(CakeSessionRuntimes, {
            currentStatus: () =>
              Effect.succeed({ pending: false, streaming: false, persisted: true }),
            catalogEntry: () =>
              Effect.succeed({
                id: claimed.sessionId,
                title: claimed.title,
                created: claimed.createdAt,
                modified: claimed.modifiedAt,
                messageCount: 0,
                resolved: false,
              }),
          }),
          Layer.succeed(ProjectSessionConfiguration, {
            agentDirectory: "/agent",
            sessionDirectory: "/sessions",
            resolvedSessionDirectory: "/resolved",
          }),
        ),
      ),
    );
    expect(release).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  }),
);

it.effect("explicit recovery rejects a claim if Pi has a live turn", () =>
  Effect.gen(function* () {
    const release = vi.fn(() => Effect.succeed({ ...claimed, status: "saved" as const }));
    const result = yield* Effect.result(
      recoverUncertain(claimed.sessionId, claimed.revision).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.mock(SavedDraftStorage, {
              list: () => Effect.succeed([claimed]),
              release,
            }),
            Layer.mock(CakeSessionRuntimes, {
              currentStatus: () =>
                Effect.succeed({ pending: true, streaming: false, persisted: false }),
              catalogEntry: () => Effect.succeed(undefined),
            }),
            Layer.succeed(ProjectSessionConfiguration, {
              agentDirectory: "/agent",
              sessionDirectory: "/sessions",
              resolvedSessionDirectory: "/resolved",
            }),
          ),
        ),
      ),
    );
    expect(result._tag).toBe("Failure");
    expect(release).not.toHaveBeenCalled();
  }),
);

it.effect("user-confirmed uncertain claim can be released when Pi has no current evidence", () =>
  Effect.gen(function* () {
    const saved = { ...claimed, status: "saved" as const, revision: 3 };
    const release = vi.fn(() => Effect.succeed(saved));
    const result = yield* recoverUncertain(claimed.sessionId, claimed.revision).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(SavedDraftStorage, {
            list: () => Effect.succeed([claimed]),
            release,
          }),
          Layer.mock(CakeSessionRuntimes, {
            currentStatus: () => Effect.succeed(undefined),
            catalogEntry: () => Effect.succeed(undefined),
          }),
          Layer.succeed(ProjectSessionConfiguration, {
            agentDirectory: "/agent",
            sessionDirectory: "/sessions",
            resolvedSessionDirectory: "/resolved",
          }),
        ),
      ),
    );
    expect(result).toEqual(saved);
    expect(release).toHaveBeenCalledWith(claimed.sessionId, claimed.revision);
  }),
);

it.effect("completes an interrupted claim when the durable Pi catalog contains its session", () =>
  Effect.gen(function* () {
    const release = vi.fn(() => Effect.succeed(claimed));
    const complete = vi.fn(() => Effect.succeed({ ...claimed, status: "activated" as const }));
    yield* reconcileInterrupted().pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(SavedDraftStorage, {
            list: () => Effect.succeed([claimed]),
            release,
            complete,
          }),
          Layer.mock(CakeSessionRuntimes, {
            currentStatus: () => Effect.succeed(undefined),
            catalogEntry: () =>
              Effect.succeed({
                id: claimed.sessionId,
                title: claimed.title,
                created: claimed.createdAt,
                modified: claimed.modifiedAt,
                messageCount: 1,
                resolved: false,
              }),
          }),
          Layer.succeed(ProjectSessionConfiguration, {
            agentDirectory: "/agent",
            sessionDirectory: "/sessions",
            resolvedSessionDirectory: "/resolved",
          }),
        ),
      ),
    );
    expect(complete).toHaveBeenCalledWith(claimed.sessionId, claimed.revision);
    expect(release).not.toHaveBeenCalled();
  }),
);
