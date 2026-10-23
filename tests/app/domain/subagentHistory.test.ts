import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { NodeFileSystem, NodePath } from "@effect/platform-node-shared";
import { it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Stream } from "effect";
import { expect } from "vitest";
import * as subagents from "../../../src/domain/subagents/subagents";
import { CakeSessionRuntimes, PiSessionError } from "../../../src/services/pi/CakeSessionRuntimes";
import {
  cakeWorkspaceSessionDirectory,
  loadWorkspacePiSessionPreview,
} from "../../../src/services/pi/runtime/session-discovery";
import {
  makeSubagentStorageLive,
  SubagentStorage,
} from "../../../src/services/storage/SubagentStorage";
import { makeSessionArchiveStorageLive } from "../../../src/services/storage/SessionArchiveStorageLive";
import { SubagentCoordinatorLive } from "../../../src/services/subagents/SubagentCoordinator";
import { SubagentEnvironment } from "../../../src/services/subagents/SubagentEnvironment";
import { subagentHistoryFixture } from "../helpers/subagentStorageFixture";

const platform = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer);

const assistant = (content: AssistantMessage["content"]): AssistantMessage => ({
  role: "assistant",
  content,
  api: "openai-completions",
  provider: "test",
  model: "model",
  timestamp: 1,
  stopReason: "stop",
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
});

const fixture = Effect.fn("SubagentHistoryTest.fixture")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "cake-subagent-history-" });
  const cwd = `${root}/project`;
  const sessionDirectory = `${root}/private-sessions`;
  const record = subagentHistoryFixture({ workingDirectory: cwd, sessionDirectory });
  const session = SessionManager.create(cwd, cakeWorkspaceSessionDirectory(cwd, sessionDirectory), {
    id: record.privateSessionId,
  });
  session.appendMessage({ role: "user", content: "Original investigation request", timestamp: 0 });
  session.appendMessage(
    assistant([{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "config.ts" } }]),
  );
  session.appendMessage({
    role: "toolResult",
    toolName: "read",
    toolCallId: "read-1",
    content: [{ type: "text", text: "Original tool evidence" }],
    isError: false,
    timestamp: 1,
  });
  session.appendMessage(
    assistant([{ type: "text", text: "Final result, not the only retained message" }]),
  );
  const layer = () => {
    const storage = makeSubagentStorageLive(`${root}/state`).pipe(Layer.provide(platform));
    return Layer.mergeAll(
      storage,
      SubagentCoordinatorLive.pipe(Layer.provide(storage)),
      makeSessionArchiveStorageLive(`${root}/archive`, {
        activeRoot: `${root}/primary`,
        resolvedRoot: `${root}/resolved`,
      }).pipe(Layer.provide(platform)),
      Layer.mock(SubagentEnvironment, {}),
      Layer.mock(CakeSessionRuntimes, {
        inspect: (target) =>
          Effect.tryPromise({
            try: async () => {
              const preview = await loadWorkspacePiSessionPreview(
                target.workingDirectory,
                target.sessionId,
                target.sessionDirectory,
              );
              if (!preview) throw new Error("Missing fixture Pi transcript");
              return preview;
            },
            catch: (error) => new PiSessionError({ operation: "inspect", message: String(error) }),
          }),
        forgetRecovery: () => Effect.void,
      }),
    );
  };
  return { fs, record, session, layer };
});

it.effect(
  "new backend acquisitions read the full original Pi branch without constructing a runtime or copying a transcript",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* Effect.flatMap(SubagentStorage, (storage) => storage.history.update(f.record)).pipe(
        Effect.provide(f.layer()),
      );
      for (let reload = 0; reload < 2; reload++) {
        yield* Effect.gen(function* () {
          const stream = yield* subagents.observe(f.record.parentSessionId);
          const snapshot = yield* stream.pipe(Stream.runHead);
          expect(snapshot._tag).toBe("Some");
          if (snapshot._tag !== "Some" || snapshot.value._tag !== "Snapshot")
            throw new Error("Missing history snapshot");
          const activity = snapshot.value.activities[0];
          expect(activity?.released).toBe(true);
          expect(activity?.error).toBeUndefined();
          expect(JSON.stringify(activity?.parts)).toContain("Original investigation request");
          expect(JSON.stringify(activity?.parts)).toContain("Original tool evidence");
          expect(JSON.stringify(activity?.parts)).toContain("Final result");
        }).pipe(Effect.provide(f.layer()));
      }
      // Metadata contains ownership only; original content remains exclusively in Pi.
      const history = yield* Effect.flatMap(SubagentStorage, (storage) =>
        storage.history.get(f.record.handleId),
      ).pipe(Effect.provide(f.layer()));
      expect(history).toEqual(f.record);
      expect(JSON.stringify(history)).not.toContain("Original tool evidence");
    }).pipe(Effect.provide(platform)),
);

it.effect(
  "a missing original produces an explicit read-only error and retains the identity for repair",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* Effect.flatMap(SubagentStorage, (storage) => storage.history.update(f.record)).pipe(
        Effect.provide(f.layer()),
      );
      yield* f.fs.remove(f.session.getSessionFile()!);
      yield* Effect.gen(function* () {
        const stream = yield* subagents.observe(f.record.parentSessionId);
        const snapshot = yield* stream.pipe(Stream.runHead);
        if (snapshot._tag !== "Some" || snapshot.value._tag !== "Snapshot")
          throw new Error("Missing history snapshot");
        expect(snapshot.value.activities[0]?.released).toBe(true);
        expect(snapshot.value.activities[0]?.error).toMatch(
          /could not be loaded.*Missing fixture Pi transcript/,
        );
        expect(yield* (yield* SubagentStorage).history.get(f.record.handleId)).toEqual(f.record);
      }).pipe(Effect.provide(f.layer()));
    }).pipe(Effect.provide(platform)),
);

it.effect(
  "owned transcript deletion uses exact persisted identities and preserves unrelated originals across reload",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const unrelated = subagentHistoryFixture({
        ...f.record,
        handleId: subagents.SubagentHandleId.make(crypto.randomUUID()),
        privateSessionId: crypto.randomUUID(),
        parentSessionId: "other-parent",
      });
      const other = SessionManager.create(
        unrelated.workingDirectory,
        cakeWorkspaceSessionDirectory(unrelated.workingDirectory, unrelated.sessionDirectory),
        { id: unrelated.privateSessionId },
      );
      other.appendMessage({ role: "user", content: "Unrelated user request", timestamp: 0 });
      other.appendMessage(assistant([{ type: "text", text: "Unrelated retained original" }]));
      yield* Effect.gen(function* () {
        const storage = yield* SubagentStorage;
        yield* storage.history.update(f.record);
        yield* storage.history.update(unrelated);
      }).pipe(Effect.provide(f.layer()));
      yield* subagents.deleteOwned(f.record.parentSessionId).pipe(Effect.provide(f.layer()));
      expect(yield* f.fs.exists(f.session.getSessionFile()!)).toBe(false);
      expect(yield* f.fs.exists(other.getSessionFile()!)).toBe(true);
      const retained = yield* Effect.flatMap(SubagentStorage, (storage) =>
        storage.history.list(),
      ).pipe(Effect.provide(f.layer()));
      expect(retained).toEqual([unrelated]);
    }).pipe(Effect.provide(platform)),
);
