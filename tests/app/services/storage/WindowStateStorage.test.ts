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
        registry: Schema.Struct({
          children: Schema.Struct({
            sessions: Schema.Array(
              Schema.Struct({
                state: Schema.Record(Schema.String, Schema.Json),
                children: Schema.Struct({
                  conversationSessionStore: Schema.Struct({
                    children: Schema.Struct({
                      chatStore: Schema.Struct({
                        state: Schema.Record(Schema.String, Schema.Json),
                      }),
                      composerStore: Schema.Struct({
                        state: Schema.Record(Schema.String, Schema.Json),
                        children: Schema.Struct({
                          draftStore: Schema.Struct({
                            state: Schema.Record(Schema.String, Schema.Json),
                          }),
                        }),
                      }),
                    }),
                  }),
                }),
              }),
            ),
          }),
        }),
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
                registry: {
                  state: { targets: [] },
                  children: {
                    sessions: [
                      {
                        key: "cake-chat-1",
                        state: {},
                        children: {
                          conversationSessionStore: {
                            state: {},
                            children: {
                              chatStore: { state: {}, children: {} },
                              composerStore: {
                                state: {},
                                children: {
                                  draftStore: {
                                    state: {
                                      text: "Keep this draft",
                                      attachments: [attachment],
                                      annotations: [annotation],
                                    },
                                    children: {},
                                  },
                                },
                              },
                            },
                          },
                        },
                      },
                    ],
                  },
                },
                pendingSessions: { state: { sessions: [] }, children: {} },
              },
            },
          },
        });
      }),
    );
  });

  it.effect("moves Project Session pending and retention state into focused child Stores", () => {
    const snapshot = {
      state: {},
      children: {
        sessionRegistry: {
          state: {
            targets: [{ sessionId: "draft-1", workspacePath: "/project" }],
            unlistedNewSessionIds: ["draft-1"],
            materializedSessionIds: ["loaded-1"],
            pendingConfigurationsBySession: {
              "draft-1": { provider: "openai", modelId: "gpt-5", thinkingLevel: "high" },
            },
            pendingNamesBySession: { "draft-1": "Draft" },
            draftSessionsById: {
              "draft-1": { text: "Do this later", attachments: [], resolved: false },
            },
            temporarySessionIds: ["draft-1"],
            pendingSummaryMetadataBySession: {
              "draft-1": { createdAt: "2026-01-01", modifiedAt: "2026-01-02" },
            },
            stagedSessionIds: ["draft-1"],
          },
          children: { sessions: [] },
        },
      },
    };

    return withStorage(JSON.stringify({ version: 4, data: snapshot }), (storage) =>
      Effect.gen(function* () {
        const loaded = yield* storage.load();
        assert.deepStrictEqual(loaded, {
          state: {},
          children: {
            sessionRegistry: {
              state: {
                targets: [{ sessionId: "draft-1", workspacePath: "/project" }],
              },
              children: {
                sessions: [],
                pendingSessions: {
                  state: {
                    unlistedNewSessionIds: ["draft-1"],
                    configurationsBySession: {
                      "draft-1": {
                        provider: "openai",
                        modelId: "gpt-5",
                        thinkingLevel: "high",
                      },
                    },
                    namesBySession: { "draft-1": "Draft" },
                    draftsBySession: {
                      "draft-1": { text: "Do this later", attachments: [], resolved: false },
                    },
                    temporarySessionIds: ["draft-1"],
                    summaryMetadataBySession: {
                      "draft-1": { createdAt: "2026-01-01", modifiedAt: "2026-01-02" },
                    },
                    stagedSessionIds: ["draft-1"],
                  },
                  children: {},
                },
                observationRetention: {
                  state: { materializedSessionIds: ["loaded-1"] },
                  children: {},
                },
              },
            },
          },
        });
      }),
    );
  });

  it.effect("retains standalone secondary chat drafts while migrating primary drafts", () => {
    const snapshot = {
      state: {},
      children: {
        sessionRegistry: {
          state: {},
          children: {
            sessions: [
              {
                key: "project-session-1",
                state: {},
                children: {
                  chatStore: { state: { draft: "Primary draft" }, children: {} },
                  messageCommentsStore: {
                    state: {},
                    children: {
                      draftChatStore: {
                        state: { draft: "Comment draft" },
                        children: {},
                      },
                    },
                  },
                },
              },
            ],
          },
        },
        reviewsStore: {
          state: {},
          children: {
            chatStores: [
              {
                key: "review-1",
                state: { draft: "Review reply" },
                children: {},
              },
            ],
          },
        },
      },
    };

    return withStorage(JSON.stringify({ version: 3, data: snapshot }), (storage) =>
      Effect.gen(function* () {
        const loaded = yield* storage.load();
        assert.deepStrictEqual(loaded, {
          state: {},
          children: {
            sessionRegistry: {
              state: {},
              children: {
                pendingSessions: {
                  state: {
                    unlistedNewSessionIds: [],
                    configurationsBySession: {},
                    namesBySession: {},
                    draftsBySession: {},
                    temporarySessionIds: [],
                    summaryMetadataBySession: {},
                    stagedSessionIds: [],
                  },
                  children: {},
                },
                observationRetention: {
                  state: { materializedSessionIds: [] },
                  children: {},
                },
                sessions: [
                  {
                    key: "project-session-1",
                    state: {},
                    children: {
                      conversationSessionStore: {
                        state: {},
                        children: {
                          chatStore: { state: {}, children: {} },
                          composerStore: {
                            state: {},
                            children: {
                              draftStore: {
                                state: {
                                  text: "Primary draft",
                                  attachments: [],
                                  annotations: [],
                                },
                                children: {},
                              },
                            },
                          },
                        },
                      },
                      messageCommentsStore: {
                        state: {},
                        children: {
                          draftChatStore: {
                            state: { localDraft: "Comment draft" },
                            children: {},
                          },
                        },
                      },
                    },
                  },
                ],
              },
            },
            reviewsStore: {
              state: {},
              children: {
                chatStores: [
                  {
                    key: "review-1",
                    state: { localDraft: "Review reply" },
                    children: {},
                  },
                ],
              },
            },
          },
        });
      }),
    );
  });

  it.effect("moves version-five Cake Chat ownership into focused child Stores", () => {
    const snapshot = {
      state: {},
      children: {
        cakeChatCollectionStore: {
          state: {
            selectedSessionId: "cake-chat-1",
            targets: ["cake-chat-1"],
            pendingSessions: [
              {
                sessionId: "cake-chat-1",
                started: false,
                createdAt: "1970-01-01T00:00:00.000Z",
                modifiedAt: "1970-01-01T00:00:00.000Z",
                messageCount: 0,
              },
            ],
          },
          children: {
            loadedSessions: [{ key: "cake-chat-1", state: {}, children: {} }],
          },
        },
      },
    };

    return withStorage(JSON.stringify({ version: 5, data: snapshot }), (storage) =>
      Effect.gen(function* () {
        const loaded = (yield* storage.load()) as unknown as {
          children: {
            cakeChatCollectionStore: {
              state: unknown;
              children: Record<string, unknown>;
            };
          };
        };
        const collection = loaded.children.cakeChatCollectionStore;
        assert.deepStrictEqual(collection.state, {});
        assert.deepStrictEqual(collection.children.registry, {
          state: { targets: ["cake-chat-1"] },
          children: {
            sessions: [{ key: "cake-chat-1", state: {}, children: {} }],
          },
        });
        assert.deepStrictEqual(collection.children.pendingSessions, {
          state: { sessions: snapshot.children.cakeChatCollectionStore.state.pendingSessions },
          children: {},
        });
        assert.deepStrictEqual(collection.children.sessionLayoutStore, {
          state: {
            layout: {
              kind: "pane",
              paneId: "cake-chat-pane:cake-chat-1",
              history: ["cake-chat-1"],
              historyCursor: 0,
            },
            focusedPaneId: "cake-chat-pane:cake-chat-1",
          },
          children: {},
        });
      }),
    );
  });

  it.effect("moves version-six Project-open state into ProjectOpenStore", () => {
    const snapshot = {
      state: {},
      children: {
        projectWorkbenchStore: {
          state: { projectPath: "/restored", unrelated: "retained" },
          children: {},
        },
      },
    };

    return withStorage(JSON.stringify({ version: 6, data: snapshot }), (storage) =>
      Effect.gen(function* () {
        const loaded = (yield* storage.load()) as unknown as {
          children: {
            projectWorkbenchStore: {
              state: Record<string, unknown>;
              children: Record<string, unknown>;
            };
          };
        };
        const workbench = loaded.children.projectWorkbenchStore;
        assert.deepStrictEqual(workbench.state, { unrelated: "retained" });
        assert.deepStrictEqual(workbench.children.projectOpenStore, {
          state: { projectPath: "/restored" },
          children: {},
        });
      }),
    );
  });

  it.effect("nests version-seven Project and Cake Chat conversation children", () => {
    const conversationChildren = {
      composerStore: {
        state: {},
        children: { draftStore: { state: { text: "Restored" }, children: {} } },
      },
      configurationStore: { state: { catalogModels: [] }, children: {} },
      chatStore: { state: {}, children: {} },
    };
    const snapshot = {
      state: {},
      children: {
        sessionRegistry: {
          state: {},
          children: {
            sessions: [
              {
                key: "project-1",
                state: { ideMode: true },
                children: { ...conversationChildren, worktreeStore: { state: {}, children: {} } },
              },
            ],
          },
        },
        cakeChatCollectionStore: {
          state: {},
          children: {
            registry: {
              state: {},
              children: {
                sessions: [{ key: "cake-chat-1", state: {}, children: conversationChildren }],
              },
            },
          },
        },
      },
    };

    return withStorage(JSON.stringify({ version: 7, data: snapshot }), (storage) =>
      Effect.gen(function* () {
        const loaded = (yield* storage.load()) as unknown as typeof snapshot;
        const project = loaded.children.sessionRegistry.children.sessions[0]!;
        const cakeChat =
          loaded.children.cakeChatCollectionStore.children.registry.children.sessions[0]!;
        assert.deepStrictEqual(project.state, { ideMode: true });
        assert.deepStrictEqual(project.children.worktreeStore, { state: {}, children: {} });
        const projectChildren = project.children as Record<string, unknown>;
        const cakeChatChildren = cakeChat.children as Record<string, unknown>;
        assert.deepStrictEqual(
          (projectChildren.conversationSessionStore as { children: unknown }).children,
          conversationChildren,
        );
        assert.deepStrictEqual(
          (cakeChatChildren.conversationSessionStore as { children: unknown }).children,
          conversationChildren,
        );
        assert.equal("composerStore" in projectChildren, false);
        assert.equal("chatStore" in cakeChatChildren, false);
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
        const session =
          projection.children.cakeChatCollectionStore.children.registry.children.sessions[0]!;
        assert.deepStrictEqual(session.state, {});
        const conversation = session.children.conversationSessionStore;
        assert.deepStrictEqual(conversation.children.chatStore.state, {});
        assert.deepStrictEqual(conversation.children.composerStore.state, {});
        assert.deepStrictEqual(conversation.children.composerStore.children.draftStore.state, {
          text: "Keep this draft",
          attachments: [attachment],
          annotations: [],
        });
      }),
    );
  });
});
