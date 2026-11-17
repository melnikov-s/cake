import { unusedMessageLookupLayer } from "../helpers/heldAttentionHarness";
import { AgentControlTestLive } from "../helpers/agentControlTestLayer";
import { makeProjectSessionRuntimeTestLayer } from "./projectSessionRuntimeTestLayer";
import { projectTodoLayer } from "../helpers/projectTodoHarness";
import { familyStorageHarness } from "../helpers/familyStorageHarness";
import * as messageReferences from "../../../src/domain/conversations/messageReferences";
import {
  describeMessageReferences,
  validateMessageReferenceControl,
} from "../../../src/domain/conversations/messageReferenceForwarding";
import * as PiMessageHistory from "../../../src/services/pi/PiMessageHistory";
import { TaskInputStorage } from "../../../src/services/storage/TaskInputStorage";
import { ApplicationState } from "../../../src/services/storage/ApplicationState";
import { makeSubagentParent } from "../../../src/domain/subagents/subagentControl";
import { jsonValueSchema } from "../../../src/contracts/serialization/json-contract";
import { subagentLink } from "../../../src/contracts/subagents/subagent-reference";
import { MessageReadInput } from "../../../src/contracts/conversations/message-reference";
import { Schema } from "effect";
import * as subagentLifetime from "../../../src/domain/subagents/subagentLifetime";
import * as subagentObservation from "../../../src/domain/subagents/subagentObservation";
import * as subagentData from "../../../src/contracts/subagents/subagent-data";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { NodeFileSystem, NodePath } from "@effect/platform-node-shared";
import { it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Stream } from "effect";
import { expect, vi } from "vitest";

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
          const stream = yield* subagentObservation.observe(f.record.parentSessionId);
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
        const stream = yield* subagentObservation.observe(f.record.parentSessionId);
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
        handleId: subagentData.SubagentHandleId.make(crypto.randomUUID()),
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
      yield* subagentLifetime.deleteOwned(f.record.parentSessionId).pipe(Effect.provide(f.layer()));
      expect(yield* f.fs.exists(f.session.getSessionFile()!)).toBe(false);
      expect(yield* f.fs.exists(other.getSessionFile()!)).toBe(true);
      const retained = yield* Effect.flatMap(SubagentStorage, (storage) =>
        storage.history.list(),
      ).pipe(Effect.provide(f.layer()));
      expect(retained).toEqual([unrelated]);
    }).pipe(Effect.provide(platform)),
);

it.effect.each(["active", "released"] as const)(
  "forwards exact $0 worker metadata across restart without reading bodies or acquiring a parent runtime",
  (state) =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const entryId = f.session.appendMessage(assistant([{ type: "text", text: "SELECTED_BODY" }]));
      f.session.appendMessage(assistant([{ type: "text", text: "LATEST_UNRELATED_BODY" }]));
      const ref = subagentLink(f.record.parentSessionId, f.record.handleId, entryId);
      yield* Effect.gen(function* () {
        const storage = yield* SubagentStorage;
        if (state === "released") yield* storage.history.update(f.record);
        else
          yield* storage.update({
            handleId: f.record.handleId,
            privateSessionId: f.record.privateSessionId,
            privateSessionDirectory: f.record.sessionDirectory,
            parentSessionId: f.record.parentSessionId,
            parentProfile: "CakeChatSession",
            parentWorkingDirectory: f.record.parentWorkingDirectory,
            parentSessionDirectory: "/parent-sessions",
            anchorPartId: f.record.anchorPartId,
            workingDirectory: f.record.workingDirectory,
            task: f.record.task,
            allowMutations: false,
            resolvedModel: f.record.resolvedModel,
            fastMode: false,
            tools: ["read"],
            inputReferences: [],
            messageReferences: [],
            continuation: "none",
            notifyOnCompletion: false,
            completionId: crypto.randomUUID(),
            completionDisposition: "waited",
            status: "complete",
            pendingInputs: [],
          });
      }).pipe(Effect.provide(f.layer()));
      const read = vi.spyOn(PiMessageHistory, "read");
      const list = vi.spyOn(PiMessageHistory, "list");
      yield* Effect.gen(function* () {
        for (let restart = 0; restart < 2; restart++) {
          const sourceLayer = Layer.mergeAll(
            AgentControlTestLive,
            makeProjectSessionRuntimeTestLayer(),
            f.layer(),
            unusedMessageLookupLayer,
            projectTodoLayer(),
            familyStorageHarness().layer,
            Layer.mock(TaskInputStorage, {}),
            Layer.mock(ApplicationState, {
              snapshot: () => {
                throw new Error("Unexpected runtime assembly");
              },
            }),
          );
          yield* Effect.gen(function* () {
            const metadata = yield* describeMessageReferences([ref]);
            expect(metadata[0]).toMatchObject({
              ref,
              link: ref,
              sessionId: f.record.parentSessionId,
              entryId,
              role: "assistant",
            });
            expect(JSON.stringify(metadata)).not.toMatch(/SELECTED_BODY|LATEST_UNRELATED_BODY/);
            expect(JSON.stringify(metadata)).not.toContain(f.record.privateSessionId);
            for (const name of ["sessions.create", "sessions.send"])
              yield* validateMessageReferenceControl({ name, arguments: { messageRefs: [ref] } });
            for (const [invalid, reason] of [
              [subagentLink("wrong-parent", f.record.handleId, entryId), /wrong parent/],
              [
                subagentLink(f.record.parentSessionId, crypto.randomUUID(), entryId),
                /Unknown subagent/,
              ],
              [
                subagentLink(f.record.parentSessionId, f.record.handleId, "missing"),
                /does not exist/,
              ],
            ] as const) {
              const error = yield* describeMessageReferences([invalid]).pipe(Effect.flip);
              expect(String(error)).toMatch(reason);
            }
            const parent = makeSubagentParent(
              {
                profile: { _tag: "ProjectSession" },
                runtime: {
                  cwd: f.record.workingDirectory,
                  agentDir: "/agent",
                  sessionDir: "/parent-sessions",
                  requestUi: async () => undefined,
                  messageReferenceControl: {
                    read: (input, signal) =>
                      Effect.runPromise(
                        messageReferences
                          .read(input)
                          .pipe(
                            Effect.map(Schema.decodeUnknownSync(jsonValueSchema)),
                            Effect.provide(sourceLayer),
                          ),
                        { signal },
                      ),
                    list: async () => {
                      throw new Error("No source listing");
                    },
                    open: async () => {
                      throw new Error("No source navigation");
                    },
                  },
                },
              },
              f.record.parentSessionId,
              f.record.workingDirectory,
              (effect, signal) =>
                Effect.runPromise(Effect.provide(effect, sourceLayer), { signal }),
            );
            const selected = parent.messages?.("selected-recipient");
            const sibling = parent.messages?.("sibling-recipient");
            expect(selected).toBeDefined();
            expect(sibling).toBeDefined();
            if (!selected || !sibling) throw new Error("Missing message access");
            selected.forward([ref]);
            expect(read).not.toHaveBeenCalled();
            const signal = new AbortController().signal;
            const page = yield* Effect.promise(() => selected.control.read({ ref }, signal));
            expect(page).toMatchObject({ text: "SELECTED_BODY", message: { ref, entryId } });
            yield* Effect.promise(() =>
              expect(sibling.control.read({ ref }, signal)).rejects.toThrow(/not forwarded/),
            );
            yield* Effect.promise(() =>
              expect(
                selected.control.read(
                  { ref: subagentLink(f.record.parentSessionId, f.record.handleId, "missing") },
                  signal,
                ),
              ).rejects.toThrow(/not forwarded/),
            );
            expect(read).toHaveBeenCalledTimes(1);
            read.mockClear();
          }).pipe(Effect.provide(sourceLayer));
        }
        expect(read).not.toHaveBeenCalled();
        expect(list).toHaveBeenCalledWith(
          {
            sessionId: f.record.privateSessionId,
            workingDirectory: f.record.workingDirectory,
            sessionDirectory: f.record.sessionDirectory,
          },
          {
            sessionId: f.record.privateSessionId,
            branch: "all",
            entryId,
            limit: 1,
          },
        );
        yield* f.fs.remove(f.session.getSessionFile()!);
        const missing = yield* describeMessageReferences([ref]).pipe(
          Effect.provide(
            Layer.mergeAll(
              AgentControlTestLive,
              makeProjectSessionRuntimeTestLayer(),
              f.layer(),
              unusedMessageLookupLayer,
              projectTodoLayer(),
              familyStorageHarness().layer,
            ),
          ),
          Effect.flip,
        );
        expect(String(missing)).toMatch(/missing or inaccessible/);
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            read.mockRestore();
            list.mockRestore();
          }),
        ),
      );
    }).pipe(Effect.provide(platform)),
);

it.effect(
  "public exact worker refs read their persisted Pi entry after release/restart, never the latest response",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const entryId = f.session.appendMessage(
        assistant([{ type: "text", text: "Exact selected result" }]),
      );
      f.session.appendMessage(assistant([{ type: "text", text: "Later unrelated turn" }]));
      const ref = subagentLink(f.record.parentSessionId, f.record.handleId, entryId);
      const input = Schema.decodeUnknownSync(MessageReadInput)({ ref });
      yield* Effect.flatMap(SubagentStorage, (storage) => storage.history.update(f.record)).pipe(
        Effect.provide(f.layer()),
      );
      for (let restart = 0; restart < 2; restart++) {
        const sourceLayer = Layer.mergeAll(
          f.layer(),
          unusedMessageLookupLayer,
          projectTodoLayer(),
          familyStorageHarness().layer,
        );
        const page = yield* messageReferences.read(input).pipe(Effect.provide(sourceLayer));
        expect(page.message.ref).toBe(ref);
        expect(page.message.link).toBe(ref);
        expect(page.text).toBe("Exact selected result");
        expect(
          (yield* Effect.result(
            messageReferences
              .read({
                ref: subagentLink("wrong-parent", f.record.handleId, entryId),
              })
              .pipe(Effect.provide(sourceLayer)),
          ))._tag,
        ).toBe("Failure");
        expect(
          (yield* Effect.result(
            messageReferences
              .read({
                ref: subagentLink(f.record.parentSessionId, f.record.handleId, "missing"),
              })
              .pipe(Effect.provide(sourceLayer)),
          ))._tag,
        ).toBe("Failure");
      }
    }).pipe(Effect.provide(platform)),
);
