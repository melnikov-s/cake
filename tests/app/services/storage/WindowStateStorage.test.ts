import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { describe } from "vitest";
import { Effect, FileSystem, Layer, Path, PlatformError, Schema } from "effect";
import {
  makeWindowStateStorageLive,
  WindowStateStorage,
} from "../../../../src/services/storage/WindowStateStorage";

const documentPath = "data/window-state.json";

const failure = (method: string) =>
  PlatformError.systemError({
    _tag: "Unknown",
    module: "TestFileSystem",
    method,
  });

const withStorage = <A, E>(
  content: string,
  use: (storage: WindowStateStorage["Service"]) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const files = new Map([[documentPath, content]]);
    const fileSystem = FileSystem.makeNoop({
      exists: (path) => Effect.succeed(files.has(path)),
      readFileString: (path) => {
        const value = files.get(path);
        return value === undefined ? Effect.fail(failure("readFileString")) : Effect.succeed(value);
      },
      writeFileString: (path, value) =>
        Effect.sync(() => {
          files.set(path, value);
        }),
      chmod: () => Effect.void,
      rename: (source, target) => {
        const value = files.get(source);
        if (value === undefined) return Effect.fail(failure("rename"));
        files.set(target, value);
        files.delete(source);
        return Effect.void;
      },
      remove: (path) =>
        Effect.sync(() => {
          files.delete(path);
        }),
    });
    const layer = makeWindowStateStorageLive("data").pipe(
      Layer.provide(Layer.succeed(FileSystem.FileSystem)(fileSystem)),
      Layer.provide(Path.layer),
    );
    return yield* Effect.gen(function* () {
      const storage = yield* WindowStateStorage;
      return yield* use(storage);
    }).pipe(Effect.provide(layer));
  });

const CakeChatComposerProjection = Schema.Struct({
  children: Schema.Struct({
    cakeChatCollectionStore: Schema.Struct({
      children: Schema.Struct({
        loadedSessions: Schema.Array(
          Schema.Struct({
            state: Schema.Record(Schema.String, Schema.Json),
            children: Schema.Struct({
              chatStore: Schema.Struct({ state: Schema.Record(Schema.String, Schema.Json) }),
              composerStore: Schema.Struct({ state: Schema.Record(Schema.String, Schema.Json) }),
            }),
          }),
        ),
      }),
    }),
  }),
});

describe("WindowStateStorage", () => {
  it.effect("migrates Cake Chat composer input into the shared composer Store", () => {
    const attachment = {
      kind: "image",
      name: "pasted.png",
      mimeType: "image/png",
      data: "abc",
    };
    const annotation = {
      id: "annotation-1",
      kind: "note",
      text: "Review this",
    };
    const snapshot = {
      state: {},
      children: {
        cakeChatCollectionStore: {
          state: {},
          children: {
            loadedSessions: [
              {
                key: "cake-chat-1",
                state: { attachments: [attachment], annotations: [annotation] },
                children: {
                  chatStore: { state: { draft: "Keep this draft" }, children: {} },
                },
              },
            ],
          },
        },
      },
    };

    return withStorage(JSON.stringify({ version: 2, data: snapshot }), (storage) =>
      Effect.gen(function* () {
        const loaded = yield* storage.load();
        assert.deepStrictEqual(loaded, {
          state: {},
          children: {
            cakeChatCollectionStore: {
              state: {},
              children: {
                loadedSessions: [
                  {
                    key: "cake-chat-1",
                    state: {},
                    children: {
                      chatStore: { state: { draft: "Keep this draft" }, children: {} },
                      composerStore: {
                        state: { attachments: [attachment], annotations: [annotation] },
                        children: {},
                      },
                    },
                  },
                ],
              },
            },
          },
        });
      }),
    );
  });

  it.effect("places unversioned Cake Chat input under the shared composer Store", () => {
    const attachment = {
      kind: "image",
      name: "legacy.png",
      mimeType: "image/png",
      data: "abc",
    };
    const legacy = {
      activeConversation: { kind: "cake-chat", sessionId: "cake-chat-1" },
      pendingCakeChat: {
        sessionId: "cake-chat-1",
        draft: "Keep this draft",
        stagedPrompt: { text: "Saved prompt", attachments: [attachment] },
      },
    };

    return withStorage(JSON.stringify(legacy), (storage) =>
      Effect.gen(function* () {
        const loaded = yield* storage.load();
        const projection = yield* Schema.decodeUnknownEffect(CakeChatComposerProjection)(loaded);
        const session = projection.children.cakeChatCollectionStore.children.loadedSessions[0]!;
        assert.deepStrictEqual(session.state, {});
        assert.deepStrictEqual(session.children.chatStore.state, { draft: "Keep this draft" });
        assert.deepStrictEqual(session.children.composerStore.state, {
          attachments: [attachment],
          annotations: [],
        });
      }),
    );
  });
});
