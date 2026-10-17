import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import {
  Deferred,
  Effect,
  Fiber,
  Layer,
  Queue,
  Ref,
  Schema,
  Stream,
  SubscriptionRef,
} from "effect";
import { describe, vi } from "vitest";
import { cakeOperationImageResult } from "../../../src/contracts/agent/cake-operation";
import type { TaskInputReference } from "../../../src/contracts/conversations/task-input";
import type { MessageOperationControl } from "../../../src/contracts/conversations/message-reference";
import type { SubagentAttachmentFactory } from "../../../src/contracts/subagents/subagent-attachments";
import { CakeOperationRegistry } from "../../../src/services/pi/runtime/cake-operation-registry";
import { configureCakeSessionRuntime } from "../../../src/layers/CakeOperations";
import { makeSubagentControl } from "../../../src/domain/subagents/subagentControl";
import { TaskInputStorage } from "../../../src/services/storage/TaskInputStorage";
import { SessionFamilyStorage } from "../../../src/services/storage/SessionFamilyStorage";
import { familyStorageHarness } from "../helpers/familyStorageHarness";
import { TestClock } from "effect/testing";
import * as subagents from "../../../src/domain/subagents/subagents";
import {
  defaultApplicationState,
  type ApplicationState as ApplicationStateValue,
} from "../../../src/contracts/application/application-data";
import type { ConversationSnapshot } from "../../../src/contracts/conversations/session-contract";
import {
  makeCakeSessionRuntimesLayer,
  PiSessionError,
  type CakeSessionRuntimeAcquireOptions,
  type CakeSessionRuntimes,
  type CakeSessionRuntimesAdapter,
} from "../../../src/services/pi/CakeSessionRuntimes";
import type { CakeSessionRuntimeSetup } from "../../../src/services/pi/CakeSessionRuntimes";
import type { CakeSessionRuntime } from "../../../src/services/pi/runtime/cake-session-runtime";
import { subagentSystemPrompt } from "../../../src/services/pi/subagent-system-prompt";
import {
  SubagentCoordinator,
  SubagentCoordinatorLive,
} from "../../../src/services/subagents/SubagentCoordinator";
import {
  makeSubagentEnvironmentLayer,
  type SubagentEnvironment,
} from "../../../src/services/subagents/SubagentEnvironment";
import { ApplicationState } from "../../../src/services/storage/ApplicationState";

const applicationValue: ApplicationStateValue = {
  ...defaultApplicationState(),
  trustedProjectPaths: ["/project", "/another"],
  projects: ["/project", "/another", "/untrusted"].map((path) => ({
    path,
    name: path.slice(1),
    addedAt: "now",
    lastOpenedAt: "now",
  })),
};

const parentSnapshot: ConversationSnapshot = {
  workspacePath: "/project",
  sessionId: "parent",
  sessionFile: "/sessions/parent.jsonl",
  parts: [],
  model: { provider: "test", id: "model", name: "Model" },
  models: [
    {
      provider: "test",
      providerName: "Test",
      id: "model",
      name: "Model",
      reasoning: true,
      availableThinkingLevels: ["off"],
      fastMode: true,
      input: ["text"],
      authenticated: true,
      available: true,
      authTypes: [],
    },
  ],
  thinkingLevel: "off",
  availableThinkingLevels: ["off"],
  streaming: false,
  diagnostics: [],
  commands: [],
  compatibility: { resources: [], diagnostics: [] },
  extensionUi: { statuses: [] },
  tree: [],
};

const applicationLayer = Layer.effect(
  ApplicationState,
  Effect.gen(function* () {
    const projection = yield* SubscriptionRef.make({ revision: 0, state: applicationValue });
    return ApplicationState.of({
      initialize: () => Effect.succeed(applicationValue),
      current: () => SubscriptionRef.get(projection).pipe(Effect.map((value) => value.state)),
      snapshot: () => SubscriptionRef.getUnsafe(projection).state,
      changes: () => SubscriptionRef.changes(projection),
      transact: (transition) =>
        SubscriptionRef.updateAndGetEffect(projection, (current) =>
          transition(current.state).pipe(
            Effect.map((state) => ({ revision: current.revision + 1, state })),
          ),
        ).pipe(Effect.map((value) => value.state)),
    });
  }),
);

interface Fixture {
  readonly layer: Layer.Layer<
    | ApplicationState
    | CakeSessionRuntimes
    | SubagentCoordinator
    | SubagentEnvironment
    | SessionFamilyStorage
  >;
  readonly parentOptions: CakeSessionRuntimeAcquireOptions;
  readonly childStarted: Queue.Queue<string>;
  readonly childGates: Ref.Ref<ReadonlyMap<string, Deferred.Deferred<void>>>;
  readonly constructions: Ref.Ref<number>;
  readonly constructedOptions: Ref.Ref<ReadonlyArray<CakeSessionRuntimeSetup>>;
  readonly active: Ref.Ref<number>;
  readonly maximumActive: Ref.Ref<number>;
  readonly completions: Ref.Ref<ReadonlyArray<unknown>>;
  readonly reports: Queue.Queue<unknown>;
  readonly parentMessages: Ref.Ref<ReadonlyArray<string>>;
  readonly childPrompts: Ref.Ref<ReadonlyArray<{ sessionId: string; text: string }>>;
}

const makeFixture = Effect.fn("SubagentsTest.makeFixture")(function* (
  failStart = false,
  finalAnswer?: string,
): Effect.fn.Return<Fixture> {
  const childStarted = yield* Queue.unbounded<string>();
  const childGates = yield* Ref.make<ReadonlyMap<string, Deferred.Deferred<void>>>(new Map());
  const constructions = yield* Ref.make(0);
  const constructedOptions = yield* Ref.make<ReadonlyArray<CakeSessionRuntimeSetup>>([]);
  const active = yield* Ref.make(0);
  const maximumActive = yield* Ref.make(0);
  const completions = yield* Ref.make<ReadonlyArray<unknown>>([]);
  const reports = yield* Queue.unbounded<unknown>();
  const parentMessages = yield* Ref.make<ReadonlyArray<string>>([]);
  const childPrompts = yield* Ref.make<ReadonlyArray<{ sessionId: string; text: string }>>([]);

  const runtime = (options: CakeSessionRuntimeSetup): CakeSessionRuntime => {
    const sessionId = options.sessionId ?? "parent";
    const isParent = sessionId.startsWith("parent");
    let streaming = false;
    let answered = false;
    let activeTurnIds: string[] = [];
    const snapshot = (): ConversationSnapshot => ({
      ...parentSnapshot,
      sessionId,
      sessionFile: options.ephemeral ? "" : `/sessions/${sessionId}.jsonl`,
      workspacePath: options.cwd,
      parts: options.ephemeral
        ? [
            {
              id: "system",
              kind: "context",
              title: "System prompt",
              text: "PRIVATE_WORKER_CONTEXT",
            },
            {
              id: "read",
              kind: "tool",
              name: "read",
              input: "config.ts",
              output: "PRIVATE_TOOL_OUTPUT",
              state: "success",
            },
            ...(answered
              ? [
                  {
                    id: "answer",
                    kind: "text" as const,
                    role: "assistant" as const,
                    status: "complete" as const,
                    text: finalAnswer ?? "Evidence: config.ts:12 defines the setting.",
                  },
                ]
              : []),
          ]
        : answered && finalAnswer
          ? [
              {
                id: "answer",
                kind: "text",
                role: "assistant",
                status: "complete",
                text: finalAnswer,
              },
            ]
          : [],
      streaming,
    });
    return {
      sessionId,
      sessionFile: `/sessions/${sessionId}.jsonl`,
      get streaming() {
        return streaming;
      },
      executingTurnIds: () => activeTurnIds,
      getReviewParentContext: () => ({
        sessionId,
        sessionFile: `/sessions/${sessionId}.jsonl`,
        systemPrompt: "test",
        activeTools: ["read", "bash", "edit", "write", "cake"],
      }),
      snapshot: async () => snapshot(),
      listQueuedMessages: async () => ({ steering: [], followUp: [] }),
      pendingMessages: async () => ({ items: [] }),
      reorderPendingMessage: async () => ({ items: [] }),
      clearQueue: async () => ({ steering: [], followUp: [] }),
      cancelSteering: async () => ({ steering: [], followUp: [] }),
      removeQueuedMessage: async () => ({ steering: [], followUp: [] }),
      steerQueuedMessage: async () => ({ steering: [], followUp: [] }),
      sendQueuedMessageNow: async () => ({
        queued: { steering: [], followUp: [] },
        abortedTurnIds: [],
      }),
      prompt: async (text, _delivery, _attachments, _markdown, turnId) => {
        if (isParent) {
          await Effect.runPromise(Ref.update(parentMessages, (values) => [...values, text]));
          return;
        }
        await Effect.runPromise(
          Ref.update(childPrompts, (values) => [...values, { sessionId, text }]),
        );
        if (turnId) activeTurnIds = [...activeTurnIds, turnId];
        const gate = Deferred.makeUnsafe<void>();
        await Effect.runPromise(
          Ref.update(childGates, (values) => new Map(values).set(sessionId, gate)),
        );
        const now = await Effect.runPromise(Ref.updateAndGet(active, (count) => count + 1));
        await Effect.runPromise(Ref.update(maximumActive, (maximum) => Math.max(maximum, now)));
        streaming = true;
        await Effect.runPromise(Queue.offer(childStarted, sessionId));
        await Effect.runPromise(Deferred.await(gate));
        activeTurnIds = turnId ? activeTurnIds.filter((id) => id !== turnId) : activeTurnIds;
        streaming = false;
        answered = true;
        await Effect.runPromise(Ref.update(active, (count) => count - 1));
        options.onEvent({ type: "streaming", sessionId, streaming: false });
      },
      setUserMessageMarkdown: async () => undefined,
      queueCommand: async () => {
        throw new Error("Unexpected queueCommand");
      },
      inspectSession: async () => {
        throw new Error("Unexpected inspectSession");
      },
      compact: async () => undefined,
      abort: async () => {
        if (!isParent)
          options.onEvent({ type: "part-removed", sessionId, partId: "partial-answer" });
        const gate = (await Effect.runPromise(Ref.get(childGates))).get(sessionId);
        if (gate) await Effect.runPromise(Deferred.succeed(gate, undefined));
      },
      setModel: async () => undefined,
      setThinkingLevel: async () => undefined,
      applyConfiguration: async () => undefined,
      setFastMode: async () => undefined,
      setPiSetting: async () => undefined,
      recordReviewRun: () => undefined,
      notifySubagentCompletion: async (result) => {
        await Effect.runPromise(Ref.update(completions, (values) => [...values, result]));
        await Effect.runPromise(Queue.offer(reports, result));
      },
      rename: async () => undefined,
      fork: async () => ({
        sessionId: "fork",
        sessionFile: "/sessions/fork.jsonl",
        artifactPointers: [],
      }),
      toolCompact: async () => ({
        sessionId: "toolCompact",
        sessionFile: "/sessions/toolCompact.jsonl",
      }),
      navigate: async () => undefined,
      dispose: () => undefined,
    };
  };

  const adapter: CakeSessionRuntimesAdapter = {
    sessionIds: () => Stream.empty,
    catalog: () => Stream.empty,
    catalogEntry: () => Effect.succeed(undefined),
    inspect: () => Effect.succeed(undefined),
    createRuntime: (options) =>
      Ref.update(constructedOptions, (values) => [...values, options]).pipe(
        Effect.andThen(
          Ref.update(
            constructions,
            (count) => count + (options.sessionId?.startsWith("parent") ? 0 : 1),
          ),
        ),
        Effect.andThen(() =>
          failStart && options.auxiliary
            ? Effect.fail(
                new PiSessionError({
                  operation: "create",
                  message: "Fixture worker failed to load",
                }),
              )
            : Effect.succeed(runtime(options)),
        ),
      ),
    changelog: () => Effect.succeed("# Changelog"),
  };
  const layer = Layer.mergeAll(
    applicationLayer,
    makeCakeSessionRuntimesLayer(adapter),
    SubagentCoordinatorLive,
    familyStorageHarness().layer,
    makeSubagentEnvironmentLayer({
      location: (workingDirectory) =>
        Effect.succeed({
          workingDirectory: workingDirectory ?? "/home",
          agentDirectory: "/agent",
          sessionDirectory: "/private-sessions",
          trusted: true,
        }),
    }),
  );
  const parentOptions = {
    profile: { _tag: "ProjectSession" as const },
    runtime: {
      cwd: "/project",
      trusted: true,
      agentDir: "/agent",
      sessionDir: "/sessions",
      sessionId: "parent",
      requestUi: async () => undefined,
    },
  };
  return {
    layer,
    parentOptions,
    childStarted,
    childGates,
    constructions,
    constructedOptions,
    active,
    maximumActive,
    completions,
    reports,
    parentMessages,
    childPrompts,
  };
});

const parent = (
  fixture: Fixture,
  parentSessionId = "parent",
  workingDirectory = "/project",
): subagents.SubagentParentRuntime => ({
  parentSessionId,
  workingDirectory,
  options: {
    ...fixture.parentOptions,
    runtime: {
      ...fixture.parentOptions.runtime,
      cwd: workingDirectory,
      sessionId: parentSessionId,
    },
  },
  runEffect: (effect) => Effect.runPromise(effect),
});

const completeChild = Effect.fn("SubagentsTest.completeChild")(function* (
  fixture: Fixture,
  sessionId: string,
) {
  const gate = (yield* Ref.get(fixture.childGates)).get(sessionId);
  assert.ok(gate);
  yield* Deferred.succeed(gate, undefined);
});

const cakeChatParent = (fixture: Fixture): subagents.SubagentParentRuntime => ({
  ...parent(fixture),
  parentSessionId: "parent-cake-chat",
  workingDirectory: "/home",
  options: {
    profile: { _tag: "CakeChatSession" },
    runtime: {
      ...fixture.parentOptions.runtime,
      sessionId: "parent-cake-chat",
      cwd: "/home",
      globalControl: { tools: [], invoke: async () => ({}) },
    },
  },
});

const imageReference: TaskInputReference = {
  kind: "input",
  id: "00000000-0000-4000-8000-000000000001",
  name: "diagram.png",
  mimeType: "image/png",
  byteLength: 68,
};
const textReference: TaskInputReference = {
  kind: "input",
  id: "00000000-0000-4000-8000-000000000002",
  name: "notes.txt",
  mimeType: "text/plain",
  byteLength: 15,
};
const tinyPng =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";

function makeAttachmentFixture() {
  const grants = new Map<string, TaskInputReference[]>();
  const forwards = vi.fn(async (owner: string, recipient: string, ids: readonly string[]) => {
    assert.equal(owner, "parent-cake-chat");
    const references = ids.map((id) => {
      const reference = [imageReference, textReference].find((item) => item.id === id);
      if (!reference) throw new Error("Attachment is not authorized");
      return reference;
    });
    grants.set(recipient, [
      ...new Map(
        [...(grants.get(recipient) ?? []), ...references].map((ref) => [ref.id, ref]),
      ).values(),
    ]);
    return references;
  });
  const reads = vi.fn(async (recipient: string, id: string) => {
    if (!grants.get(recipient)?.some((reference) => reference.id === id))
      throw new Error("Attachment is not authorized");
    return cakeOperationImageResult({ reference: { ...imageReference } }, [
      { type: "image", data: tinyPng, mimeType: "image/png" },
    ]);
  });
  const factory: SubagentAttachmentFactory = (owner, recipient) => ({
    forward: (ids) => forwards(owner, recipient, ids),
    control: {
      list: async () => ({
        references: (grants.get(recipient) ?? []).map((ref) => ({ ...ref })),
        nextAfter: null,
      }),
      read: async (input) => reads(recipient, input.reference),
    },
  });
  return { factory: vi.fn(factory), forwards, reads, grants };
}

const workerRegistry = (options: CakeSessionRuntimeSetup) => {
  const runtime = configureCakeSessionRuntime(options);
  assert.ok(runtime.operations);
  return new CakeOperationRegistry(
    runtime.operations({
      host: { appendEntry: () => undefined },
      api: () => {
        throw new Error("No session authority granted");
      },
      sessionId: () => options.sessionId,
      getAvailableOfType: async () => [],
      publishSnapshot: async () => undefined,
    }),
  );
};
const invokeWorker = (registry: CakeOperationRegistry, command: string, input: object = {}) =>
  registry.invoke(
    { command, input },
    { signal: new AbortController().signal, toolCallId: "input-test", runtime: {} },
  );

describe("subagent exact message references", () => {
  it.effect(
    "forwards identities without reading and gates initial/follow-up reads to explicitly selected messages",
    () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        const first = "cake://session/source?message=entry-1";
        const second = "cake://session/source?message=entry-2";
        const read = vi.fn<MessageOperationControl["read"]>(async (input) => ({
          message: {
            ref: input.ref,
            link: input.ref,
            sessionId: "source",
            entryId: input.ref === first ? "entry-1" : "entry-2",
            parentId: null,
            timestamp: "now",
            role: "user",
            active: true,
            inputRefs: [{ ...imageReference }],
            hasImages: true,
          },
          text: "PRIVATE_SOURCE_TEXT",
          totalChars: 19,
          offset: 0,
          nextOffset: null,
          truncated: false,
        }));
        const source: MessageOperationControl = {
          read,
          list: async () => {
            throw new Error("Unexpected broad message listing");
          },
          open: async () => {
            throw new Error("Unexpected session navigation");
          },
        };
        const authorizeForward = vi.fn<TaskInputStorage["Service"]["authorizeForward"]>(() =>
          Effect.succeed([]),
        );
        yield* Effect.gen(function* () {
          const context = yield* Effect.context<
            | ApplicationState
            | CakeSessionRuntimes
            | SubagentCoordinator
            | SubagentEnvironment
            | TaskInputStorage
            | SessionFamilyStorage
          >();
          const caller = cakeChatParent(fixture);
          const options = {
            ...caller.options,
            runtime: { ...caller.options.runtime, messageReferenceControl: source },
          };
          const control = makeSubagentControl({
            runEffect: (effect, signal) =>
              Effect.runPromise(Effect.provide(effect, context), { signal }),
          })(() => options, caller.workingDirectory);
          const receipt = Schema.decodeUnknownSync(subagents.SubagentStartReceipt)(
            yield* Effect.promise(() =>
              control.start(
                { task: "Assess this exact source", messageRefs: [first] },
                caller.parentSessionId,
                new AbortController().signal,
              ),
            ),
          );
          const id = yield* Queue.take(fixture.childStarted);
          assert.equal(read.mock.calls.length, 0);
          assert.equal(authorizeForward.mock.calls.length, 0);
          const prompt = (yield* Ref.get(fixture.childPrompts)).at(-1)?.text ?? "";
          assert.ok(prompt.includes(first));
          assert.ok(!prompt.includes("PRIVATE_SOURCE_TEXT"));
          const worker = (yield* Ref.get(fixture.constructedOptions)).find(
            (value) => value.sessionId === id,
          );
          assert.ok(worker);
          assert.deepEqual(worker.allowedCakeOperations, [
            "attachments.list",
            "attachments.read",
            "messages.read",
          ]);
          const registry = workerRegistry(worker);
          assert.ok(!registry.help().includes("messages.list"));
          assert.ok(!registry.help().includes("messages.open"));
          yield* Effect.promise(() =>
            assert.rejects(
              invokeWorker(registry, "messages.read", { ref: second }),
              /not forwarded/,
            ),
          );
          assert.equal(read.mock.calls.length, 0);
          const result = yield* Effect.promise(() =>
            invokeWorker(registry, "messages.read", { ref: first, maxChars: 100 }),
          );
          assert.ok(result.text.includes("PRIVATE_SOURCE_TEXT"));
          assert.equal(read.mock.calls[0]?.[0].ref, first);
          yield* completeChild(fixture, id);
          yield* Queue.take(fixture.reports);
          yield* Effect.promise(() =>
            control.prompt(
              {
                handleId: receipt.handleId,
                text: "Now assess this one",
                delivery: "follow-up",
                messageRefs: [second],
              },
              caller.parentSessionId,
              new AbortController().signal,
            ),
          );
          assert.equal(yield* Queue.take(fixture.childStarted), id);
          assert.equal(read.mock.calls.length, 1);
          const followUp = (yield* Ref.get(fixture.childPrompts)).at(-1)?.text ?? "";
          assert.ok(followUp.includes(second));
          assert.ok(!followUp.includes("PRIVATE_SOURCE_TEXT"));
          yield* Effect.promise(() => invokeWorker(registry, "messages.read", { ref: second }));
          assert.equal(read.mock.calls[1]?.[0].ref, second);
          assert.equal(authorizeForward.mock.calls.length, 2);
          assert.deepEqual(authorizeForward.mock.calls[0], ["source", [imageReference.id], id]);
          yield* completeChild(fixture, id);
          yield* Queue.take(fixture.reports);
        }).pipe(
          Effect.provide(
            Layer.merge(
              fixture.layer,
              Layer.mock(TaskInputStorage, { authorizeForward, grant: () => Effect.succeed([]) }),
            ),
          ),
        );
      }),
  );
});

describe("subagent attachment references", () => {
  it.effect(
    "wires owner authorization and metadata grants through the production subagent control",
    () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        const authorizeForward = vi.fn<TaskInputStorage["Service"]["authorizeForward"]>(() =>
          Effect.succeed(["bound-grant-token"]),
        );
        const grant = vi.fn<TaskInputStorage["Service"]["grant"]>(() =>
          Effect.succeed([imageReference]),
        );
        const storage = Layer.mock(TaskInputStorage, { authorizeForward, grant });
        yield* Effect.gen(function* () {
          const context = yield* Effect.context<
            | ApplicationState
            | CakeSessionRuntimes
            | SubagentCoordinator
            | SubagentEnvironment
            | TaskInputStorage
            | SessionFamilyStorage
          >();
          const caller = cakeChatParent(fixture);
          const control = makeSubagentControl({
            runEffect: (effect, signal) =>
              Effect.runPromise(Effect.provide(effect, context), { signal }),
          })(() => caller.options, caller.workingDirectory);
          yield* Effect.promise(() =>
            control.start(
              { task: "Inspect selected diagram", inputRefs: [imageReference.id] },
              caller.parentSessionId,
              new AbortController().signal,
            ),
          );
          const sessionId = yield* Queue.take(fixture.childStarted);
          assert.deepEqual(authorizeForward.mock.calls, [
            [caller.parentSessionId, [imageReference.id], sessionId],
          ]);
          assert.deepEqual(grant.mock.calls, [[sessionId, ["bound-grant-token"]]]);
          const options = (yield* Ref.get(fixture.constructedOptions)).find(
            (value) => value.sessionId === sessionId,
          );
          assert.ok(options?.attachmentReferenceControl);
          assert.deepEqual(options.allowedCakeOperations, ["attachments.list", "attachments.read"]);
          assert.ok(
            (yield* Ref.get(fixture.childPrompts)).at(-1)?.text.includes(imageReference.id),
          );
          yield* completeChild(fixture, sessionId);
          yield* Queue.take(fixture.reports);
        }).pipe(Effect.provide(Layer.merge(fixture.layer, storage)));
      }),
  );
  it.effect(
    "forwards exact selected metadata without reading and lets investigators explicitly inspect native pixels",
    () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        const attachments = makeAttachmentFixture();
        yield* Effect.gen(function* () {
          yield* subagents.start(
            {
              task: "Inspect this diagram",
              projectPath: "/project",
              inputRefs: [imageReference.id],
            },
            { ...cakeChatParent(fixture), attachments: attachments.factory },
          );
          const sessionId = yield* Queue.take(fixture.childStarted);
          assert.deepEqual(
            attachments.forwards.mock.calls.map(([owner, recipient, ids]) => [
              owner,
              recipient,
              ids,
            ]),
            [["parent-cake-chat", sessionId, [imageReference.id]]],
          );
          assert.equal(attachments.reads.mock.calls.length, 0);
          const prompt =
            (yield* Ref.get(fixture.childPrompts)).find((value) => value.sessionId === sessionId)
              ?.text ?? "";
          assert.match(prompt, /metadata only; content has not been inspected/);
          assert.ok(prompt.includes(imageReference.id));
          assert.ok(!prompt.includes(textReference.id));
          assert.ok(!prompt.includes(tinyPng));
          const options = (yield* Ref.get(fixture.constructedOptions)).find(
            (value) => value.sessionId === sessionId,
          );
          assert.ok(options);
          assert.equal(options.projectInvestigation, true);
          const registry = workerRegistry(options);
          const listed = yield* Effect.promise(() => invokeWorker(registry, "attachments.list"));
          assert.ok(listed.text.includes(imageReference.id));
          assert.ok(!listed.text.includes(textReference.id));
          yield* Effect.promise(() =>
            assert.rejects(
              invokeWorker(registry, "attachments.read", { reference: textReference.id }),
              /not authorized/,
            ),
          );
          const image = yield* Effect.promise(() =>
            invokeWorker(registry, "attachments.read", { reference: imageReference.id }),
          );
          assert.deepEqual(image.content[1], {
            type: "image",
            data: tinyPng,
            mimeType: "image/png",
          });
          assert.ok(!JSON.stringify(image.details).includes(tinyPng));
          assert.ok(!image.text.includes(tinyPng));
          assert.equal(registry.help().includes("sessions.create"), false);
          yield* completeChild(fixture, sessionId);
          yield* Queue.take(fixture.reports);
        }).pipe(Effect.provide(fixture.layer));
      }),
  );

  it.effect(
    "shares nothing implicitly, adds exact refs on follow-up and keeps independent workers isolated",
    () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        const attachments = makeAttachmentFixture();
        yield* Effect.gen(function* () {
          const caller = { ...cakeChatParent(fixture), attachments: attachments.factory };
          const first = yield* subagents.start({ task: "General question" }, caller);
          const firstId = yield* Queue.take(fixture.childStarted);
          const second = yield* subagents.start(
            { task: "Read notes", inputRefs: [textReference.id] },
            caller,
          );
          const secondId = yield* Queue.take(fixture.childStarted);
          assert.equal(attachments.grants.has(firstId), false);
          assert.deepEqual(attachments.grants.get(secondId), [textReference]);
          const firstOptions = (yield* Ref.get(fixture.constructedOptions)).find(
            (value) => value.sessionId === firstId,
          );
          assert.ok(firstOptions);
          assert.deepEqual(firstOptions.tools, ["read", "bash", "message_parent", "cake"]);
          const registry = workerRegistry(firstOptions);
          const empty = yield* Effect.promise(() => invokeWorker(registry, "attachments.list"));
          assert.ok(!empty.text.includes(imageReference.id));
          assert.ok(!empty.text.includes(textReference.id));
          yield* completeChild(fixture, firstId);
          yield* Queue.take(fixture.reports);
          yield* subagents.prompt(
            "parent-cake-chat",
            first.handleId,
            "Now inspect the diagram",
            "follow-up",
            true,
            [imageReference.id],
          );
          assert.equal(yield* Queue.take(fixture.childStarted), firstId);
          assert.deepEqual(attachments.grants.get(firstId), [imageReference]);
          assert.deepEqual(attachments.grants.get(secondId), [textReference]);
          const added = yield* Effect.promise(() => invokeWorker(registry, "attachments.list"));
          assert.ok(added.text.includes(imageReference.id));
          assert.ok(!added.text.includes(textReference.id));
          assert.equal(attachments.factory.mock.calls.length, 2);
          assert.equal(attachments.reads.mock.calls.length, 0);
          const prompt = (yield* Ref.get(fixture.childPrompts)).at(-1)?.text ?? "";
          assert.ok(prompt.includes(imageReference.id));
          assert.ok(!prompt.includes(textReference.id));
          yield* completeChild(fixture, firstId);
          yield* Queue.take(fixture.reports);
          yield* completeChild(fixture, secondId);
          yield* Queue.take(fixture.reports);
          yield* subagents.close("parent-cake-chat", second.handleId);
        }).pipe(Effect.provide(fixture.layer));
      }),
  );

  it.effect("reports structured forwarding failures as readable SubagentErrors", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const attachments = makeAttachmentFixture();
      attachments.forwards.mockRejectedValueOnce(
        Object.assign(new Error("outer"), {
          message: { message: "Grant failed", issues: [{ message: "reference expired" }] },
        }),
      );
      const caller = { ...cakeChatParent(fixture), attachments: attachments.factory };
      const error = yield* subagents
        .start({ task: "Inspect", inputRefs: [imageReference.id] }, caller)
        .pipe(Effect.flip, Effect.provide(fixture.layer));
      assert.equal(error._tag, "SubagentError");
      assert.equal(error.message, "Grant failed: reference expired");
    }),
  );

  it.effect(
    "rejects unauthorized forwarding without starting a worker or consuming a follow-up turn",
    () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        const attachments = makeAttachmentFixture();
        yield* Effect.gen(function* () {
          const caller = { ...cakeChatParent(fixture), attachments: attachments.factory };
          const denied = yield* subagents
            .start({ task: "Inspect", inputRefs: ["missing"] }, caller)
            .pipe(Effect.flip);
          assert.match(denied.message, /not authorized/);
          assert.equal(yield* Ref.get(fixture.constructions), 0);
          const unavailable = yield* subagents
            .start({ task: "Inspect", inputRefs: [imageReference.id] }, cakeChatParent(fixture))
            .pipe(Effect.flip);
          assert.match(unavailable.message, /unavailable/);
          const receipt = yield* subagents.start({ task: "Inspect" }, caller);
          const id = yield* Queue.take(fixture.childStarted);
          yield* completeChild(fixture, id);
          yield* Queue.take(fixture.reports);
          const rejected = yield* subagents
            .prompt("parent-cake-chat", receipt.handleId, "Inspect missing", "follow-up", true, [
              "missing",
            ])
            .pipe(Effect.flip);
          assert.match(rejected.message, /not authorized/);
          assert.equal(yield* Queue.size(fixture.childStarted), 0);
          yield* subagents.prompt(
            "parent-cake-chat",
            receipt.handleId,
            "Still available",
            "follow-up",
            true,
          );
          assert.equal(yield* Queue.take(fixture.childStarted), id);
          yield* completeChild(fixture, id);
          yield* Queue.take(fixture.reports);
        }).pipe(Effect.provide(fixture.layer));
      }),
  );
});

describe("Cake Chat project investigators", () => {
  it.effect(
    "reports a failed runtime acquisition as failed-to-start with no invented worker activity",
    () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture(true);
        yield* Effect.gen(function* () {
          yield* subagents.start({ task: "Cannot start" }, cakeChatParent(fixture));
          const report = Schema.decodeUnknownSync(subagents.SubagentResult)(
            yield* Queue.take(fixture.reports),
          );
          assert.equal(report.status, "error");
          assert.equal(report.failurePhase, "start");
          assert.match(report.error ?? "", /Fixture worker failed to load/);
          assert.deepEqual(report.parts, []);
          assert.equal(yield* Queue.size(fixture.childStarted), 0);
        }).pipe(Effect.provide(fixture.layer));
      }),
  );
  it.effect(
    "starts project-free isolated research, delivers once, follows up on the same handle and expires",
    () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        yield* Effect.gen(function* () {
          const caller = { ...cakeChatParent(fixture), workingDirectory: "/unrelated-repository" };
          const receipt = yield* subagents.start(
            { task: "Compare Godot and Three.js", instructions: "Cite actually inspected sources" },
            caller,
          );
          const sessionId = yield* Queue.take(fixture.childStarted);
          const options = (yield* Ref.get(fixture.constructedOptions)).find(
            (item) => item.sessionId === sessionId,
          );
          assert.ok(options);
          assert.equal(options.cwd, "/home");
          assert.equal(options.ephemeral, true);
          assert.equal(options.projectInvestigation, undefined);
          assert.deepEqual(options.tools, ["read", "bash", "message_parent"]);
          assert.match(
            options.isolatedSystemPrompt ?? "",
            /no project instructions, skills, extensions or MCP/,
          );
          assert.match(options.isolatedSystemPrompt ?? "", /no guaranteed web\/search access/);
          assert.match(options.isolatedSystemPrompt ?? "", /Investigations only/);
          assert.doesNotMatch(options.isolatedSystemPrompt ?? "", /Mutation mode/);
          assert.equal(receipt.projectPath, undefined);
          yield* completeChild(fixture, sessionId);
          const report = Schema.decodeUnknownSync(subagents.SubagentResult)(
            yield* Queue.take(fixture.reports),
          );
          assert.equal(report.status, "complete");
          assert.equal(report.projectPath, undefined);
          assert.equal(report.parts.length, 1);
          yield* subagents.prompt(
            "parent-cake-chat",
            receipt.handleId,
            "Compare deployment",
            "follow-up",
            true,
          );
          assert.equal(yield* Queue.take(fixture.childStarted), sessionId);
          yield* completeChild(fixture, sessionId);
          yield* Queue.take(fixture.reports);
          assert.equal(yield* Queue.size(fixture.reports), 0);
          assert.equal(yield* Ref.get(fixture.constructions), 1);
          yield* TestClock.adjust("30 minutes");
          const coordinator = yield* SubagentCoordinator;
          assert.equal((yield* SubscriptionRef.get(coordinator.state)).handles.size, 0);
        }).pipe(Effect.provide(fixture.layer));
      }),
  );
  it.effect(
    "starts Cake Chat workers in scoped mutation mode only when allowMutations is set",
    () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        yield* Effect.gen(function* () {
          yield* subagents.start(
            {
              task: "Kill the orphaned quick-serve Node servers",
              projectPath: "/another",
              instructions: "Report every PID you kill",
              allowMutations: true,
            },
            cakeChatParent(fixture),
          );
          const projectSession = yield* Queue.take(fixture.childStarted);
          const projectOptions = (yield* Ref.get(fixture.constructedOptions)).find(
            (item) => item.sessionId === projectSession,
          );
          assert.ok(projectOptions);
          assert.equal(projectOptions.projectInvestigation, true);
          assert.equal(projectOptions.allowMutations, true);
          assert.equal(projectOptions.tools, undefined);
          assert.match(
            (yield* Ref.get(fixture.childPrompts)).find(
              (value) => value.sessionId === projectSession,
            )?.text ?? "",
            /subject to your scoped mutation-mode system instructions/,
          );
          yield* completeChild(fixture, projectSession);
          yield* Queue.take(fixture.reports);

          yield* subagents.start(
            { task: "Remove a stale temp directory", allowMutations: true },
            cakeChatParent(fixture),
          );
          const researchSession = yield* Queue.take(fixture.childStarted);
          const researchOptions = (yield* Ref.get(fixture.constructedOptions)).find(
            (item) => item.sessionId === researchSession,
          );
          assert.ok(researchOptions);
          assert.equal(researchOptions.allowMutations, undefined);
          assert.deepEqual(researchOptions.tools, ["read", "bash", "message_parent"]);
          assert.match(researchOptions.isolatedSystemPrompt ?? "", /Mutation mode/);
          assert.match(
            researchOptions.isolatedSystemPrompt ?? "",
            /Report exactly what you changed/,
          );
          assert.doesNotMatch(researchOptions.isolatedSystemPrompt ?? "", /Investigations only/);
          yield* completeChild(fixture, researchSession);
          yield* Queue.take(fixture.reports);

          const wrongCaller = yield* subagents
            .start({ task: "Kill processes", allowMutations: true }, parent(fixture))
            .pipe(Effect.flip);
          assert.match(wrongCaller.message, /allowMutations is available only to Cake Chat/);
        }).pipe(Effect.provide(fixture.layer));
      }),
  );
  it.effect("never expires a worker mid-turn and releases it once idle after its lifetime", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      yield* Effect.gen(function* () {
        const coordinator = yield* SubagentCoordinator;
        const handleOf = (handleId: string) =>
          SubscriptionRef.get(coordinator.state).pipe(
            Effect.map((state) =>
              state.handles.get(Schema.decodeUnknownSync(subagents.SubagentHandleId)(handleId)),
            ),
          );
        const receipt = yield* subagents.start(
          { task: "Long architecture audit", projectPath: "/another" },
          cakeChatParent(fixture),
        );
        const sessionId = yield* Queue.take(fixture.childStarted);

        // The initial turn outlives the handle lifetime.
        yield* TestClock.adjust("45 minutes");
        assert.equal((yield* handleOf(receipt.handleId))?.status, "running");
        assert.equal(yield* Queue.size(fixture.reports), 0);
        yield* completeChild(fixture, sessionId);
        const first = Schema.decodeUnknownSync(subagents.SubagentResult)(
          yield* Queue.take(fixture.reports),
        );
        assert.equal(first.status, "complete");
        assert.match(JSON.stringify(first.parts), /config.ts:12/);

        // Once idle after its lifetime, the worker is released.
        yield* SubscriptionRef.changes(coordinator.state).pipe(
          Stream.filter((state) => state.handles.size === 0),
          Stream.runHead,
        );
        assert.equal(yield* handleOf(receipt.handleId), undefined);
      }).pipe(Effect.provide(fixture.layer));
    }),
  );

  it.effect("keeps a follow-up running past the lifetime before releasing the idle worker", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      yield* Effect.gen(function* () {
        const coordinator = yield* SubagentCoordinator;
        const receipt = yield* subagents.start({ task: "Initial pass" }, cakeChatParent(fixture));
        const sessionId = yield* Queue.take(fixture.childStarted);
        yield* completeChild(fixture, sessionId);
        yield* Queue.take(fixture.reports);
        yield* TestClock.adjust("20 minutes");
        yield* subagents.prompt(
          "parent-cake-chat",
          receipt.handleId,
          "Dig deeper",
          "follow-up",
          true,
        );
        assert.equal(yield* Queue.take(fixture.childStarted), sessionId);
        yield* TestClock.adjust("3 hours");
        const during = (yield* SubscriptionRef.get(coordinator.state)).handles.get(
          Schema.decodeUnknownSync(subagents.SubagentHandleId)(receipt.handleId),
        );
        assert.equal(during?.status, "running");
        yield* completeChild(fixture, sessionId);
        const followUp = Schema.decodeUnknownSync(subagents.SubagentResult)(
          yield* Queue.take(fixture.reports),
        );
        assert.equal(followUp.status, "complete");
        yield* SubscriptionRef.changes(coordinator.state).pipe(
          Stream.filter((state) => state.handles.size === 0),
          Stream.runHead,
        );
      }).pipe(Effect.provide(fixture.layer));
    }),
  );

  it.effect("validates registered trusted project roots before constructing a worker", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      yield* Effect.gen(function* () {
        for (const projectPath of ["/missing", "/untrusted", "/project/worktree"])
          assert.ok(
            (yield* subagents
              .start(
                { task: "Inspect config", ...(projectPath ? { projectPath } : {}) },
                cakeChatParent(fixture),
              )
              .pipe(Effect.flip)) instanceof subagents.SubagentError,
          );
        assert.equal(yield* Ref.get(fixture.constructions), 0);
        const wrongCaller = yield* subagents
          .start({ task: "Inspect", projectPath: "/another" }, parent(fixture))
          .pipe(Effect.flip);
        assert.match(wrongCaller.message, /only to Cake Chat/);
      }).pipe(Effect.provide(fixture.layer));
    }),
  );

  it.effect("aborts a queued follow-up before it can start on an existing private runtime", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      yield* Effect.gen(function* () {
        const first = yield* subagents.start(
          { task: "First investigation", projectPath: "/another" },
          cakeChatParent(fixture),
        );
        const firstSession = yield* Queue.take(fixture.childStarted);
        yield* completeChild(fixture, firstSession);
        yield* Queue.take(fixture.reports);
        const blockers: string[] = [];
        for (let i = 0; i < 4; i++) {
          yield* subagents.start(
            { task: `Occupy slot ${i}`, projectPath: "/another" },
            cakeChatParent(fixture),
          );
          blockers.push(yield* Queue.take(fixture.childStarted));
        }
        yield* subagents.prompt(
          "parent-cake-chat",
          first.handleId,
          "Must not start after cancellation",
          "follow-up",
          true,
        );
        yield* subagents.abort("parent-cake-chat", first.handleId);
        const cancelled = Schema.decodeUnknownSync(subagents.SubagentResult)(
          yield* Queue.take(fixture.reports),
        );
        assert.equal(cancelled.handleId, first.handleId);
        assert.equal(cancelled.status, "aborted");
        assert.deepEqual(cancelled.parts, []);
        for (const sessionId of blockers) yield* completeChild(fixture, sessionId);
        yield* Effect.forEach(blockers, () => Queue.take(fixture.reports));
        assert.equal(yield* Queue.size(fixture.childStarted), 0);
        assert.equal(yield* Ref.get(fixture.active), 0);
      }).pipe(Effect.provide(fixture.layer));
    }),
  );

  it.effect(
    "binds an in-memory worker to the selected root and keeps its detailed activity private across async follow-ups",
    () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        yield* Effect.gen(function* () {
          const receipt = yield* subagents.start(
            {
              task: "Inspect config",
              projectPath: "/another",
              instructions: "Also explain the defaults",
            },
            cakeChatParent(fixture),
          );
          const sessionId = yield* Queue.take(fixture.childStarted);
          const options = (yield* Ref.get(fixture.constructedOptions)).find(
            (item) => item.sessionId === sessionId,
          );
          assert.ok(options);
          assert.equal(options.cwd, "/another");
          assert.equal(options.ephemeral, true);
          assert.equal(options.projectInvestigation, true);
          assert.equal(options.allowMutations, false);
          assert.equal(options.isolatedSystemPrompt, undefined);
          assert.equal(options.tools, undefined);
          assert.match(
            (yield* Ref.get(fixture.childPrompts)).find((value) => value.sessionId === sessionId)
              ?.text ?? "",
            /subject to your investigation-only system instructions/,
          );
          assert.equal(receipt.projectPath, "/another");
          const coordinator = yield* SubagentCoordinator;
          assert.equal(
            (yield* SubscriptionRef.get(coordinator.state)).handles.get(receipt.handleId)
              ?.parentSessionId,
            "parent-cake-chat",
          );
          yield* completeChild(fixture, sessionId);
          const first = Schema.decodeUnknownSync(subagents.SubagentResult)(
            yield* Queue.take(fixture.reports),
          );
          assert.equal(first.parts.length, 1);
          assert.match(JSON.stringify(first), /config.ts:12/);
          assert.doesNotMatch(JSON.stringify(first), /PRIVATE_/);
          assert.match(
            JSON.stringify(
              (yield* SubscriptionRef.get(coordinator.state)).handles.get(receipt.handleId)?.parts,
            ),
            /PRIVATE_TOOL_OUTPUT/,
          );
          assert.equal(subagents.SubagentResult.make(first).projectPath, "/another");
          const followUp = yield* subagents.prompt(
            "parent-cake-chat",
            receipt.handleId,
            "Recheck the current default",
            "follow-up",
            true,
          );
          assert.equal(
            Schema.decodeUnknownSync(subagents.SubagentStartReceipt)(followUp).handleId,
            receipt.handleId,
          );
          assert.equal(yield* Queue.take(fixture.childStarted), sessionId);
          yield* completeChild(fixture, sessionId);
          const second = Schema.decodeUnknownSync(subagents.SubagentResult)(
            yield* Queue.take(fixture.reports),
          );
          assert.equal(second.parts.length, 1);
          assert.doesNotMatch(JSON.stringify(second), /PRIVATE_/);
          assert.equal(yield* Ref.get(fixture.constructions), 1);
          yield* subagents.close("parent-cake-chat", receipt.handleId);
          assert.equal((yield* SubscriptionRef.get(coordinator.state)).handles.size, 0);
          const closed = yield* subagents
            .prompt("parent-cake-chat", receipt.handleId, "Again", "follow-up", true)
            .pipe(Effect.flip);
          assert.match(closed.message, /does not belong/);
        }).pipe(Effect.provide(fixture.layer));
      }),
  );
});

describe("Subagents", () => {
  it.effect.each([false, true])(
    "retains a private worker's exact reference without waking its %s Cake Chat parent",
    (chat) =>
      Effect.gen(function* () {
        const reference = "[Result](cake://session/worker?message=exact%3Aentry)";
        const fixture = yield* makeFixture(false, reference);
        yield* Effect.gen(function* () {
          const caller = chat ? cakeChatParent(fixture) : parent(fixture);
          const started = yield* subagents.start(
            { task: "Investigate", model: { prefer: "current" } },
            caller,
          );
          const childId = yield* Queue.take(fixture.childStarted);
          yield* completeChild(fixture, childId);
          const coordinator = yield* SubagentCoordinator;
          while (
            (yield* SubscriptionRef.get(coordinator.state)).handles.get(started.handleId)
              ?.completionDisposition !== "notified"
          )
            yield* Effect.yieldNow;
          assert.deepEqual(yield* Ref.get(fixture.completions), []);
          assert.deepEqual(yield* Ref.get(fixture.parentMessages), []);
          const storage = yield* SessionFamilyStorage;
          assert.deepEqual(
            (yield* storage.state()).deferredReferences?.map(({ recipientSessionId, text }) => ({
              recipientSessionId,
              text,
            })),
            [{ recipientSessionId: caller.parentSessionId, text: reference }],
          );
        }).pipe(Effect.provide(fixture.layer));
      }),
  );

  it.effect("uses one stable public handle without exposing the private Pi Session ID", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const program = Effect.gen(function* () {
        const receipt = yield* subagents.start({ task: "Audit the boundary" }, parent(fixture));
        const childSessionId = yield* Queue.take(fixture.childStarted);
        assert.equal(JSON.stringify(receipt).includes(childSessionId), false);
        assert.match(receipt.handleId, /^[0-9a-f-]{36}$/i);
        yield* completeChild(fixture, childSessionId);
        yield* Effect.yieldNow;
        assert.equal(yield* Ref.get(fixture.constructions), 1);
      });
      yield* program.pipe(Effect.provide(fixture.layer));
    }),
  );

  it.effect("repeated waits share one handle, one runtime, and one result", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const program = Effect.gen(function* () {
        const receipt = yield* subagents.start({ task: "Inspect callers" }, parent(fixture));
        const childSessionId = yield* Queue.take(fixture.childStarted);
        const first = yield* subagents.wait("parent", receipt.handleId).pipe(Effect.forkChild);
        const second = yield* subagents.wait("parent", receipt.handleId).pipe(Effect.forkChild);
        const coordinator = yield* SubagentCoordinator;
        while (
          (yield* SubscriptionRef.get(coordinator.state)).handles.get(receipt.handleId)?.waiters !==
          2
        )
          yield* Effect.yieldNow;
        yield* completeChild(fixture, childSessionId);
        assert.deepEqual(yield* Fiber.join(first), yield* Fiber.join(second));
        assert.equal(yield* Ref.get(fixture.constructions), 1);
        assert.equal((yield* Ref.get(fixture.completions)).length, 0);
      });
      yield* program.pipe(Effect.provide(fixture.layer));
    }),
  );

  it.effect("delivers automatically when the active wait is interrupted before completion", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const program = Effect.gen(function* () {
        const receipt = yield* subagents.start({ task: "Background race" }, parent(fixture));
        const childSessionId = yield* Queue.take(fixture.childStarted);
        const waiter = yield* subagents.wait("parent", receipt.handleId).pipe(Effect.forkChild);
        const coordinator = yield* SubagentCoordinator;
        while (
          (yield* SubscriptionRef.get(coordinator.state)).handles.get(receipt.handleId)?.waiters !==
          1
        )
          yield* Effect.yieldNow;
        yield* Fiber.interrupt(waiter);
        yield* completeChild(fixture, childSessionId);
        while ((yield* Ref.get(fixture.completions)).length === 0) yield* Effect.yieldNow;
        assert.equal((yield* Ref.get(fixture.completions)).length, 1);
      });
      yield* program.pipe(Effect.provide(fixture.layer));
    }),
  );

  it.effect("automatically delivers an unclaimed background completion exactly once", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const program = Effect.gen(function* () {
        yield* subagents.start({ task: "Background audit" }, parent(fixture));
        const childSessionId = yield* Queue.take(fixture.childStarted);
        yield* completeChild(fixture, childSessionId);
        while ((yield* Ref.get(fixture.completions)).length === 0) yield* Effect.yieldNow;
        assert.equal((yield* Ref.get(fixture.completions)).length, 1);
      });
      yield* program.pipe(Effect.provide(fixture.layer));
    }),
  );

  it.effect("preflights an entire parallel batch before constructing a child runtime", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const program = Effect.gen(function* () {
        const error = yield* Effect.flip(
          subagents.parallel(
            {
              tasks: [
                { task: "Valid", model: { prefer: "current" } },
                {
                  task: "Invalid",
                  model: { prefer: "exact", provider: "missing", modelId: "unknown" },
                },
              ],
            },
            parent(fixture),
          ),
        );
        assert.match(error.message, /missing\/unknown is unknown/);
        assert.equal(yield* Ref.get(fixture.constructions), 0);
      });
      yield* program.pipe(Effect.provide(fixture.layer));
    }),
  );

  it.effect("constructs at most four child runtimes per Working Directory", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const program = Effect.gen(function* () {
        yield* Effect.forEach(
          Array.from({ length: 6 }, (_, index) => index),
          (index) => subagents.start({ task: `Task ${index + 1}` }, parent(fixture)),
          { concurrency: "unbounded" },
        );
        const firstFour = yield* Effect.forEach([0, 1, 2, 3], () =>
          Queue.take(fixture.childStarted),
        );
        assert.equal(yield* Ref.get(fixture.constructions), 4);
        const [first, second] = firstFour;
        assert.ok(first);
        assert.ok(second);
        yield* completeChild(fixture, first);
        yield* completeChild(fixture, second);
        const fifth = yield* Queue.take(fixture.childStarted);
        const sixth = yield* Queue.take(fixture.childStarted);
        yield* completeChild(fixture, fifth);
        yield* completeChild(fixture, sixth);
        yield* Effect.forEach(firstFour.slice(2), (id) => completeChild(fixture, id), {
          discard: true,
        });
        assert.equal(yield* Ref.get(fixture.maximumActive), 4);
        assert.equal(yield* Ref.get(fixture.constructions), 6);
      });
      yield* program.pipe(Effect.provide(fixture.layer));
    }),
  );

  it.effect("cancels queued work before constructing its private runtime", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const program = Effect.gen(function* () {
        const receipts = yield* Effect.forEach(
          Array.from({ length: 5 }, (_, index) => index),
          (index) => subagents.start({ task: `Task ${index + 1}` }, parent(fixture)),
          { concurrency: "unbounded" },
        );
        const activeIds = yield* Effect.forEach([0, 1, 2, 3], () =>
          Queue.take(fixture.childStarted),
        );
        const queued = receipts[4];
        assert.ok(queued);
        yield* subagents.abort("parent", queued.handleId);
        yield* Effect.forEach(activeIds, (id) => completeChild(fixture, id), { discard: true });
        yield* Effect.yieldNow;
        assert.equal(yield* Ref.get(fixture.constructions), 4);
      });
      yield* program.pipe(Effect.provide(fixture.layer));
    }),
  );

  it.effect("uses independent four-way limits for different Working Directories", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const program = Effect.gen(function* () {
        yield* Effect.forEach(
          Array.from({ length: 4 }, (_, index) => index),
          (index) => subagents.start({ task: `Project task ${index + 1}` }, parent(fixture)),
          { concurrency: "unbounded", discard: true },
        );
        const projectIds = yield* Effect.forEach([0, 1, 2, 3], () =>
          Queue.take(fixture.childStarted),
        );
        yield* subagents.start(
          { task: "Other directory" },
          parent(fixture, "parent-other", "/other"),
        );
        const otherId = yield* Queue.take(fixture.childStarted);
        assert.equal(yield* Ref.get(fixture.constructions), 5);
        yield* Effect.forEach([...projectIds, otherId], (id) => completeChild(fixture, id), {
          discard: true,
        });
      });
      yield* program.pipe(Effect.provide(fixture.layer));
    }),
  );

  it.effect("gives the general subagent shell and file tools without Cake or delegation", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const program = Effect.gen(function* () {
        const receipt = yield* subagents.start({ task: "Review the boundary" }, parent(fixture));
        const childId = yield* Queue.take(fixture.childStarted);
        const childOptions = (yield* Ref.get(fixture.constructedOptions)).find(
          (options) => options.sessionId === childId,
        );
        assert.ok(childOptions);
        assert.deepEqual(childOptions.tools, ["read", "bash", "edit", "write", "message_parent"]);
        assert.deepEqual(
          childOptions.customTools?.map((tool) => tool.name),
          ["message_parent"],
        );
        assert.equal(childOptions.agentControl, undefined);
        assert.equal(childOptions.additionalSystemPrompt, undefined);
        assert.equal(childOptions.isolatedSystemPrompt, subagentSystemPrompt());
        yield* completeChild(fixture, childId);
        yield* subagents.wait("parent", receipt.handleId);
        const coordinator = yield* SubagentCoordinator;
        assert.equal(
          (yield* SubscriptionRef.get(coordinator.state)).handles.has(receipt.handleId),
          true,
        );
        yield* subagents.close("parent", receipt.handleId);
      });
      yield* program.pipe(Effect.provide(fixture.layer));
    }),
  );

  it.effect.each([
    "I found a blocker in the queue policy.",
    "[Report](cake://session/worker?message=entry)",
  ])("keeps deliberate message_parent communication immediate: %s", (text) =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const program = Effect.gen(function* () {
        yield* subagents.start({ task: "Audit messaging" }, parent(fixture));
        const childId = yield* Queue.take(fixture.childStarted);
        const childOptions = (yield* Ref.get(fixture.constructedOptions)).find(
          (options) => options.sessionId === childId,
        );
        const tool = childOptions?.customTools?.find(
          (candidate) => candidate.name === "message_parent",
        );
        assert.ok(tool);

        yield* Effect.promise(() =>
          tool.execute("message-call", { text } as never, undefined, undefined, {} as never),
        );

        while ((yield* Ref.get(fixture.parentMessages)).length === 0) yield* Effect.yieldNow;
        const messages = yield* Ref.get(fixture.parentMessages);
        assert.equal(messages.length, 1);
        assert.match(messages[0] ?? "", /Message from subagent/);
        assert.ok(messages[0]?.includes(text));
        assert.equal(
          (yield* (yield* SessionFamilyStorage).state()).deferredReferences?.length ?? 0,
          0,
        );
        yield* completeChild(fixture, childId);
      });
      yield* program.pipe(Effect.provide(fixture.layer));
    }),
  );

  it.effect("serializes follow-up turns on the stable handle without another runtime", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const program = Effect.gen(function* () {
        const receipt = yield* subagents.start({ task: "Initial turn" }, parent(fixture));
        const childId = yield* Queue.take(fixture.childStarted);
        yield* completeChild(fixture, childId);
        while ((yield* Ref.get(fixture.completions)).length === 0) yield* Effect.yieldNow;

        const nextTurn = yield* subagents
          .prompt("parent", receipt.handleId, "Continue", "prompt")
          .pipe(Effect.forkChild);
        assert.equal(yield* Queue.take(fixture.childStarted), childId);
        const conflict = yield* Effect.flip(
          subagents.prompt("parent", receipt.handleId, "Overlap", "follow-up"),
        );
        assert.match(conflict.message, /already has active work/);
        yield* completeChild(fixture, childId);
        const result = yield* Fiber.join(nextTurn);
        assert.equal(JSON.stringify(result).includes(receipt.handleId), true);
        assert.equal(yield* Ref.get(fixture.constructions), 1);
        yield* subagents.close("parent", receipt.handleId);
      });
      yield* program.pipe(Effect.provide(fixture.layer));
    }),
  );

  it.effect("does not cut off long-running initial or follow-up turns", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const program = Effect.gen(function* () {
        const receipt = yield* subagents.start({ task: "Self-healing audit" }, parent(fixture));
        const childId = yield* Queue.take(fixture.childStarted);
        const waiter = yield* subagents.wait("parent", receipt.handleId).pipe(Effect.forkChild);
        yield* TestClock.adjust("6 hours");
        assert.equal(waiter.pollUnsafe(), undefined);
        yield* completeChild(fixture, childId);
        const initial = Schema.decodeUnknownSync(subagents.SubagentResult)(
          yield* Fiber.join(waiter),
        );
        assert.equal(initial.status, "complete");

        const followUp = yield* subagents
          .prompt("parent", receipt.handleId, "Keep going", "follow-up")
          .pipe(Effect.forkChild);
        assert.equal(yield* Queue.take(fixture.childStarted), childId);
        yield* TestClock.adjust("6 hours");
        assert.equal(followUp.pollUnsafe(), undefined);
        yield* completeChild(fixture, childId);
        const result = Schema.decodeUnknownSync(subagents.SubagentResult)(
          yield* Fiber.join(followUp),
        );
        assert.equal(result.status, "complete");
        assert.equal(yield* Ref.get(fixture.constructions), 1);
        yield* subagents.close("parent", receipt.handleId);
      });
      yield* program.pipe(Effect.provide(fixture.layer));
    }),
  );

  it.effect("preserves partial transcript history when an active child is aborted", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const program = Effect.gen(function* () {
        const receipt = yield* subagents.start({ task: "Keep partial work" }, parent(fixture));
        const childId = yield* Queue.take(fixture.childStarted);
        const childOptions = (yield* Ref.get(fixture.constructedOptions)).find(
          (options) => options.sessionId === childId,
        );
        assert.ok(childOptions);
        childOptions.onEvent({
          type: "part-updated",
          sessionId: childId,
          part: {
            id: "partial-answer",
            kind: "text",
            role: "assistant",
            text: "Partial evidence gathered before cancellation.",
            status: "streaming",
          },
        });
        const coordinator = yield* SubagentCoordinator;
        while (
          (yield* SubscriptionRef.get(coordinator.state)).handles.get(receipt.handleId)?.parts
            .length !== 1
        )
          yield* Effect.yieldNow;

        yield* subagents.abort("parent", receipt.handleId);
        yield* subagents.wait("parent", receipt.handleId);

        const handle = (yield* SubscriptionRef.get(coordinator.state)).handles.get(
          receipt.handleId,
        );
        assert.equal(handle?.result?.status, "aborted");
        assert.match(JSON.stringify(handle?.result?.parts), /Partial evidence gathered/);
      });
      yield* program.pipe(Effect.provide(fixture.layer));
    }),
  );

  it.effect("does not rewrite a completed result when its parent aborts", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const program = Effect.gen(function* () {
        const receipt = yield* subagents.start({ task: "Keep this result" }, parent(fixture));
        const childId = yield* Queue.take(fixture.childStarted);
        yield* completeChild(fixture, childId);
        while ((yield* Ref.get(fixture.completions)).length === 0) yield* Effect.yieldNow;
        yield* subagents.abortParentChildren("parent");
        const coordinator = yield* SubagentCoordinator;
        assert.equal(
          (yield* SubscriptionRef.get(coordinator.state)).handles.get(receipt.handleId)?.status,
          "complete",
        );
        yield* subagents.close("parent", receipt.handleId);
      });
      yield* program.pipe(Effect.provide(fixture.layer));
    }),
  );

  it.effect("reconnect observation starts with the parent's current live handles", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const program = Effect.gen(function* () {
        const receipt = yield* subagents.start({ task: "Observe me" }, parent(fixture));
        yield* Queue.take(fixture.childStarted);
        const updates = yield* subagents.observe("parent");
        const first = yield* Stream.runHead(updates);
        assert.equal(first._tag, "Some");
        if (first._tag === "Some") {
          assert.equal(first.value._tag, "Snapshot");
          if (first.value._tag === "Snapshot")
            assert.deepEqual(
              first.value.activities.map((activity) => activity.handleId),
              [receipt.handleId],
            );
        }
        yield* subagents.close("parent", receipt.handleId);
      });
      yield* program.pipe(Effect.provide(fixture.layer));
    }),
  );

  it.effect("parent release closes subagents", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const program = Effect.gen(function* () {
        const receipt = yield* subagents.start({ task: "Persistent child" }, parent(fixture));
        yield* Queue.take(fixture.childStarted);
        yield* subagents.releaseParent("parent");
        const coordinator = yield* SubagentCoordinator;
        assert.equal(
          (yield* SubscriptionRef.get(coordinator.state)).handles.has(receipt.handleId),
          false,
        );
      });
      yield* program.pipe(Effect.provide(fixture.layer));
    }),
  );

  it.effect("rejects a handle owned by another parent", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const program = Effect.gen(function* () {
        const receipt = yield* subagents.start({ task: "Audit" }, parent(fixture));
        const error = yield* Effect.flip(subagents.wait("another-parent", receipt.handleId));
        assert.equal(error._tag, "SubagentError");
        assert.match(error.message, /does not belong/);
        yield* subagents.close("parent", receipt.handleId);
      });
      yield* program.pipe(Effect.provide(fixture.layer));
    }),
  );
});
