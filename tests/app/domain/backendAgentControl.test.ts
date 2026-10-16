import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Context, Deferred, Effect, Fiber, Layer, Queue, Schema, Stream } from "effect";
import { expect } from "vitest";
import {
  defaultApplicationState,
  defaultProjectSettings,
} from "../../../src/contracts/application/application-data";
import {
  jsonObjectSchema,
  type JsonObject,
  type JsonValue,
} from "../../../src/contracts/serialization/json-contract";
import { CAKE_CHAT_SESSION_ID } from "../../../src/contracts/cake-chats/cake-chat-identity";
import { messageReference } from "../../../src/contracts/conversations/message-reference";
import { parseCrossSessionMessage } from "../../../src/contracts/conversations/cross-session-message";
import type { SavedDraft } from "../../../src/contracts/project-sessions/saved-draft-data";
import { ProjectAccess } from "../../../src/services/projects/ProjectAccess";
import { SavedDraftStorage } from "../../../src/services/storage/SavedDraftStorage";
import { backendAgentTools } from "../../../src/contracts/application/backend-agent-tools";
import { CakeOperationRegistry } from "../../../src/services/pi/runtime/cake-operation-registry";
import { createGlobalControlOperations } from "../../../src/domain/application/cake-global-control-operations";
import type { Attachment } from "../../../src/contracts/conversations/session-contract";
import { AttachmentUploadError } from "../../../src/contracts/filesystem/attachment-uploads-errors";
import type { CakeEvent } from "../../../src/contracts/application/cake-rpc-contract";
import { acquireOptions } from "../../../src/domain/project-sessions/projectSessionRuntime";
import * as cakeChatRuntime from "../../../src/domain/cake-chats/cakeChatRuntime";
import * as agentControl from "../../../src/domain/application/agentControl";
import { ApplicationState } from "../../../src/services/storage/ApplicationState";
import { ApplicationStorage } from "../../../src/services/storage/ApplicationStorage";
import { TaskInputStorage } from "../../../src/services/storage/TaskInputStorage";
import { SessionArchiveStorage } from "../../../src/services/storage/SessionArchiveStorage";
import { SessionFamilyStorage } from "../../../src/services/storage/SessionFamilyStorage";
import {
  CakeSessionRuntimes,
  PiSessionError,
  makeCakeSessionRuntimesLayer,
} from "../../../src/services/pi/CakeSessionRuntimes";
import { ClientConnectionsLive } from "../../../src/services/clients/ClientConnections";
import { ClientEvents } from "../../../src/services/clients/ClientEvents";
import { ClientEventsLive } from "../../../src/services/clients/ClientEventsLive";
import {
  RendererRequestCoordinator,
  RendererRequestCoordinatorLive,
} from "../../../src/services/renderer-requests/RendererRequestCoordinator";
import { SessionCatalogChanges } from "../../../src/services/session-catalogs/SessionCatalogChanges";
import { ManagedWorktrees } from "../../../src/services/worktrees/ManagedWorktrees";
import { WorkflowTestLive } from "../helpers/workflowFixture";
import { familyStorageHarness } from "../helpers/familyStorageHarness";
import { fakeRuntime, snapshot } from "../helpers/piRuntimeFixture";
import { makeHeadlessProjectSessionRuntimeMechanismTestLayer } from "./projectSessionRuntimeTestLayer";

const source = "00000000-0000-4000-8000-000000000011";
const target = "00000000-0000-4000-8000-000000000022";
const third = "00000000-0000-4000-8000-000000000033";
const location = {
  projectPath: "/project",
  projectName: "Project",
  workingDirectory: "/project",
  sessionDirectory: "/cake/sessions",
  resolvedSessionDirectory: "/cake/resolved",
};
const caller = {
  kind: "project-session" as const,
  sessionId: source,
  title: "Source",
  projectName: "Project",
  projectPath: "/project",
  workingDirectory: "/project",
};
const signal = () => new AbortController().signal;
const summary = (id: string) => ({
  id,
  title: id === source ? "Source" : "Same title",
  created: "2026-01-01",
  modified: id === target ? "2026-01-03" : "2026-01-02",
  messageCount: 1,
  resolved: false,
});

const fixture = Effect.fn("BackendAgentControlTest.fixture")(function* () {
  const prompts = yield* Queue.unbounded<{
    sessionId: string;
    text: string;
    delivery: string;
    attachments: readonly Attachment[];
  }>();
  const saves = yield* Queue.unbounded<void>();
  const saveRelease = yield* Deferred.make<void>();
  let pauseSave = false;
  let saveCount = 0;
  let restored = 0;
  let resolved = false;
  let protectedTarget = false;
  const drafts: SavedDraft[] = [];
  const deniedPaths = new Set<string>();
  const active = new Set<string>();
  const unavailable = new Set<string>();
  const failedTurns = new Set<string>();
  const admissions = yield* Queue.unbounded<void>();
  const admissionRelease = yield* Deferred.make<void>();
  let pauseAdmission = false;
  const messageRelease = yield* Deferred.make<void>();
  let pauseMessage = false;
  const protectedSessions = new Set<string>();
  const grants: unknown[] = [];
  const queries: unknown[] = [];
  const received: Array<{ connectionId: number; event: CakeEvent }> = [];
  const deliveries = yield* Queue.unbounded<{ connectionId: number; event: CakeEvent }>();
  const runtimeCreates: string[] = [];
  const requestCalls: unknown[] = [];
  const project = {
    path: "/project",
    name: "Project",
    addedAt: "2026-01-01T00:00:00.000Z",
    lastOpenedAt: "2026-01-01T00:00:00.000Z",
    settings: defaultProjectSettings(),
  };
  const storage = Layer.succeed(
    ApplicationStorage,
    ApplicationStorage.of({
      load: () =>
        Effect.succeed({
          state: {
            ...defaultApplicationState(),
            globalSessionLabels: [],
            projects: [project],
            trustedProjectPaths: ["/project"],
          },
          source: "current",
        }),
      save: () =>
        Effect.gen(function* () {
          saveCount++;
          yield* Queue.offer(saves, undefined);
          if (pauseSave) yield* Deferred.await(saveRelease);
        }),
    }),
  );
  const clients = Layer.merge(ClientConnectionsLive, ClientEventsLive);
  const renderers = RendererRequestCoordinatorLive.pipe(Layer.provideMerge(clients));
  const runtimes = makeCakeSessionRuntimesLayer({
    sessionIds: () => Stream.fromIterable([source, target, third]),
    catalog: () => Stream.fromIterable([source, target, third].map(summary)),
    catalogEntry: (_query, id) =>
      unavailable.has(id)
        ? Effect.fail(
            new PiSessionError({ operation: "catalogEntry", message: "Recipient unavailable" }),
          )
        : Effect.succeed([source, target, third].includes(id) ? summary(id) : undefined),
    inspect: ({ sessionId }) =>
      Effect.succeed({
        workspacePath: "/project",
        sessionId,
        sessionFile: `/cake/sessions/${sessionId}.jsonl`,
        parts: [
          { id: "entry", kind: "text", role: "user", text: "First input", status: "complete" },
        ],
      }),
    changelog: () => Effect.succeed(""),
    createRuntime: (options) =>
      Effect.gen(function* () {
        const sessionId = options.sessionId ?? "unexpected";
        runtimeCreates.push(sessionId);
        if (pauseAdmission && sessionId === target) {
          yield* Queue.offer(admissions, undefined);
          yield* Deferred.await(admissionRelease);
        }
        return {
          ...fakeRuntime(options, () => undefined),
          sessionId,
          sessionFile: `/cake/sessions/${sessionId}.jsonl`,
          get streaming() {
            return active.has(sessionId);
          },
          snapshot: async () => ({ ...snapshot, sessionId, streaming: active.has(sessionId) }),
          prompt: async (text, delivery, attachments) => {
            await Effect.runPromise(
              Queue.offer(prompts, { sessionId, text, delivery, attachments }),
            );
            if (pauseMessage) await Effect.runPromise(Deferred.await(messageRelease));
            if (failedTurns.has(sessionId)) throw new Error("Model failed after admission");
          },
          inspectSession: async (query): Promise<JsonValue> => {
            queries.push(query);
            if (query.kind === "messages-list") {
              const ref = messageReference(sessionId, "entry");
              return {
                sessionId,
                branch: "all",
                total: 1,
                offset: 0,
                nextOffset: null,
                messages:
                  query.entryId === "missing"
                    ? []
                    : [
                        {
                          ref,
                          link: ref,
                          sessionId,
                          entryId: "entry",
                          parentId: null,
                          timestamp: "2026-01-01",
                          role: "user",
                          active: true,
                          inputRefs: [],
                          hasImages: false,
                        },
                      ],
              };
            }
            return { total: 0, entries: [] };
          },
        };
      }),
  });
  const dependencies = Layer.mergeAll(
    WorkflowTestLive,
    Layer.mock(SavedDraftStorage, {
      list: () => Effect.succeed(drafts),
      update: (record, revision) =>
        Effect.sync(() => {
          const index = drafts.findIndex((item) => item.sessionId === record.sessionId);
          expect(drafts[index]?.revision).toBe(revision);
          const updated = { ...record, revision: revision + 1 };
          drafts[index] = updated;
          return updated;
        }),
    }),
    makeHeadlessProjectSessionRuntimeMechanismTestLayer({
      requestUi: async () => undefined,
      requestInterview: async () => undefined,
      emitExtensionUiIntent: () => undefined,
      persistArtifact: async () => {
        throw new Error("unexpected artifact");
      },
      generateInlineWidget: async () => {
        throw new Error("unexpected widget");
      },
      requestApplicationControl: (invocation, abort) => {
        requestCalls.push(invocation);
        return Effect.runPromise(requests.requestProjectControl(source, invocation, abort));
      },
    }),
    Layer.mock(ProjectAccess, {
      rememberSessionLocation: () => Effect.void,
      isAllowed: (path) => Effect.succeed(!deniedPaths.has(path)),
    }),
    runtimes,
    renderers,
    familyStorageHarness().layer,
    SessionCatalogChanges.layer,
    ApplicationState.layer.pipe(Layer.provide(storage)),
    Layer.mock(ManagedWorktrees, {
      records: () => Effect.succeed([]),
      awaitSetup: () => Effect.void,
    }),
    Layer.mock(SessionArchiveStorage, {
      resolvedProjectEntry: () => Effect.succeed(undefined),
      resolvedProjects: () => Stream.empty,
      locate: (id, at) =>
        Effect.succeed(
          at.cwd !== "/project"
            ? undefined
            : resolved && id === target
              ? ("resolved" as const)
              : ("active" as const),
        ),
      restoreProject: () =>
        Effect.sync(() => {
          restored++;
          resolved = false;
          return undefined;
        }),
    }),
    Layer.mock(TaskInputStorage, {
      isRecipient: (id) =>
        Effect.succeed((id === target && protectedTarget) || protectedSessions.has(id)),
      protectRecipient: (id) =>
        Effect.sync(() => {
          protectedSessions.add(id);
        }),
      authorizeForward: (owner, refs, recipient) =>
        Effect.gen(function* () {
          grants.push({ owner, refs, recipient });
          if (refs.some((ref) => ref !== "allowed"))
            return yield* new AttachmentUploadError({
              operation: "forward",
              message: "Input is not granted to this sender",
            });
          return refs.map((ref) => `granted/${ref}`);
        }),
      resolve: (id, attachments) =>
        Effect.sync(() => {
          grants.push({ resolve: id, attachments });
          return attachments;
        }),
    }),
  );
  const context = yield* Layer.build(dependencies);
  const requests: RendererRequestCoordinator["Service"] = Context.get(
    context,
    RendererRequestCoordinator,
  );
  yield* Context.get(context, ApplicationState).initialize();
  yield* requests.registerProjectSession(source, "/project");
  const events = Context.get(context, ClientEvents);
  const ready = yield* Queue.unbounded<void>();
  for (const connectionId of [11, 22]) {
    yield* events.application(connectionId).pipe(
      Stream.runForEach((event) =>
        event.type === "renderer-events-ready"
          ? Queue.offer(ready, undefined)
          : Effect.gen(function* () {
              received.push({ connectionId, event });
              yield* Queue.offer(deliveries, { connectionId, event });
            }),
      ),
      Effect.forkScoped,
    );
    yield* Queue.take(ready);
  }
  const options = yield* acquireOptions({ location, sessionId: source, newSession: false }).pipe(
    Effect.provide(context),
  );
  yield* Context.get(context, CakeSessionRuntimes).acquire(options);
  const invoke = options.runtime.currentSessionControl?.invokeAppControl;
  assert.ok(invoke);
  return {
    context,
    drafts,
    deny: (path: string) => deniedPaths.add(path),
    active,
    unavailable,
    failedTurns,
    messageRelease,
    admissions,
    admissionRelease,
    pauseAdmission: () => {
      pauseAdmission = true;
    },
    pauseMessage: () => {
      pauseMessage = true;
    },
    prompts,
    received,
    deliveries,
    requests,
    requestCalls,
    grants,
    queries,
    runtimeCreates,
    saves,
    saveRelease,
    call: (command: string, input: JsonObject = {}) =>
      Effect.promise(() => invoke(command, input, signal())),
    direct: (command: string, input: JsonValue, sender = caller) =>
      agentControl.invoke(command, input, sender).pipe(Effect.provide(context)),
    state: () => Context.get(context, ApplicationState).snapshot(),
    pause: () => {
      pauseSave = true;
    },
    saveCount: () => saveCount,
    resolve: () => {
      resolved = true;
    },
    restored: () => restored,
    protect: () => {
      protectedTarget = true;
    },
    protectedSessions,
  };
});

it.effect(
  "multiwindow presentation and device requests remain bound to the caller, not the message target",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.requests.bind({ _tag: "ProjectSession", sessionId: source }, 11);
      yield* f.requests.registerProjectSession(target, "/project");
      yield* f.requests.bind({ _tag: "ProjectSession", sessionId: target }, 22);
      yield* f.call("project.settings.update", { changes: { customInstructions: "One owner" } });
      const notice = yield* Queue.take(f.deliveries);
      expect(notice).toMatchObject({
        connectionId: 11,
        event: {
          type: "agent-action-notice",
          source: { sessionId: source },
          message: "Updated Cake Project settings",
        },
      });
      const waiting = yield* f.call("app.user-selection").pipe(Effect.forkChild);
      const request = yield* Queue.take(f.deliveries);
      assert.equal(request.event.type, "project-session-control-requested");
      expect(request.connectionId).toBe(11);
      expect(
        yield* f.requests
          .respondProjectControl(22, source, request.event.controlRequestId, { ok: true })
          .pipe(Effect.exit),
      ).toMatchObject({ _tag: "Failure" });
      yield* f.requests.respondProjectControl(11, source, request.event.controlRequestId, {
        ok: true,
        text: "Owning window",
      });
      expect(yield* Fiber.join(waiting)).toEqual({ ok: true, text: "Owning window" });
      expect(f.requestCalls).toHaveLength(1);
    }),
);

it.effect(
  "resolved families reject generic messaging instead of silently restoring; family inspection is backend-owned",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* Context.get(f.context, SessionFamilyStorage).addChild({
        familyId: crypto.randomUUID(),
        parentSessionId: target,
        parentWorkingDirectory: "/project",
        childSessionId: third,
        childWorkingDirectory: "/project",
        requestId: crypto.randomUUID(),
        projectPath: "/project",
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      expect(
        yield* f.direct("sessions.list-family", {}, { ...caller, sessionId: target }),
      ).toMatchObject({
        ok: true,
        rootSessionId: target,
        sessions: [{ sessionId: target }, { sessionId: third }],
      });
      f.resolve();
      expect(
        yield* f
          .call("sessions.send", { sessionId: target, text: "Do not restore a family" })
          .pipe(Effect.exit),
      ).toMatchObject({ _tag: "Failure" });
      expect(f.restored()).toBe(0);
      expect(yield* Queue.size(f.prompts)).toBe(0);
    }),
);

it.effect("project labels remain scoped to their Project before any assignment mutation", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* Context.get(f.context, ApplicationState).transact((state) =>
      Effect.succeed({
        ...state,
        projects: [
          ...state.projects,
          {
            path: "/other",
            name: "Other",
            addedAt: "2026-01-01T00:00:00.000Z",
            lastOpenedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      }),
    );
    const result = yield* f.call("session-labels.add", {
      projectPath: "/other",
      name: "Other only",
      color: "blue",
    });
    const { label } = yield* Schema.decodeUnknownEffect(
      Schema.Struct({ label: Schema.Struct({ id: Schema.String }) }),
    )(result);
    expect(
      yield* f.call("sessions.set-labels", { sessionId: target, labelIds: [label.id] }),
    ).toMatchObject({ ok: false, error: "A selected label belongs to a different Project." });
    expect(f.state().projects[0]?.workflow?.assignments ?? []).toEqual([]);
  }),
);

it.effect(
  "backend mutations preserve selected-Project authorization and resolved-session label policy",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      f.deny("/project");
      expect(
        yield* f.call("project.settings.update", { changes: { customInstructions: "Denied" } }),
      ).toMatchObject({ ok: false });
      expect(
        yield* f
          .call("session-labels.add", { projectPath: "/project", name: "Denied", color: "blue" })
          .pipe(Effect.exit),
      ).toMatchObject({ _tag: "Failure" });
      expect(
        yield* f.call("sessions.set-labels", { sessionId: target, labelIds: [] }).pipe(Effect.exit),
      ).toMatchObject({ _tag: "Failure" });
      expect(f.saveCount()).toBe(0);
      f.resolve();
      expect(
        yield* f.call("sessions.set-labels", { sessionId: target, labelIds: [] }),
      ).toMatchObject({ ok: false });
    }),
);

it.effect("executes settings, label lifecycle, and authoritative inspection with no renderer", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    expect(yield* f.call("settings.sections")).toMatchObject({
      ok: true,
      sections: expect.arrayContaining([
        expect.objectContaining({ id: "mcp", scope: "backend-or-calling-working-directory" }),
      ]),
    });
    expect(
      yield* f.call("settings.instructions.update", { instructions: " Backend-owned " }),
    ).toMatchObject({ ok: true, value: { instructions: "Backend-owned" } });
    expect(
      yield* f.call("project.settings.update", {
        changes: { customInstructions: "Project-owned" },
      }),
    ).toMatchObject({ ok: true, settings: { customInstructions: "Project-owned" } });
    const added = yield* f.call("session-labels.add", { name: "Review", color: "cyan" });
    const result = yield* Schema.decodeUnknownEffect(
      Schema.Struct({ label: Schema.Struct({ id: Schema.String }) }),
    )(added);
    const labelId = result.label.id;
    yield* f.call("sessions.set-labels", { sessionId: target, labelIds: [labelId] });
    expect(yield* f.call("sessions.info", { sessionId: target })).toMatchObject({
      ok: true,
      session: {
        sessionId: target,
        deepLink: `cake://session/${target}`,
        sessionFile: `/cake/sessions/${target}.jsonl`,
        firstUserMessage: "First input",
        labels: [{ id: labelId }],
      },
    });
    yield* f.call("session-labels.update", { labelId, name: "Ready" });
    yield* f.call("session-labels.reorder", { labelId, index: 0 });
    expect(yield* f.call("session-labels.list")).toMatchObject({
      labels: [{ id: labelId, name: "Ready" }],
    });
    yield* f.call("session-labels.remove", { labelId });
    expect(f.state().projects[0]?.workflow?.assignments[0]?.labelIds ?? []).toEqual([]);
    expect(yield* f.call("sessions.list")).toMatchObject({
      sessions: [
        { sessionId: target, title: "Same title" },
        { sessionId: source },
        { sessionId: third, title: "Same title" },
      ],
    });
    for (const command of ["history", "compactions", "tree", "context", "usage", "commands"])
      expect(yield* f.call(`sessions.${command}`, { sessionId: "s:00000022" })).toMatchObject({
        ok: true,
        target: { sessionId: target },
        result: { total: 0 },
      });
    expect(f.queries).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "history", sessionId: target })]),
    );
    expect(f.requestCalls).toEqual([]);
  }),
);

it.effect(
  "disconnect/reload during mutation admission cannot cancel or repeat backend persistence",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.requests.bind({ _tag: "ProjectSession", sessionId: source }, 11);
      f.pause();
      const pending = yield* f
        .call("session-labels.add", { name: "Exactly once", color: "mint" })
        .pipe(Effect.forkChild);
      yield* Queue.take(f.saves);
      yield* f.requests.releaseConnection(11);
      yield* f.requests.bind({ _tag: "ProjectSession", sessionId: source }, 22);
      yield* Deferred.succeed(f.saveRelease, undefined);
      expect(yield* Fiber.join(pending)).toMatchObject({ ok: true });
      expect(f.saveCount()).toBe(1);
      expect(
        f.state().globalSessionLabels.filter((label) => label.name === "Exactly once"),
      ).toHaveLength(1);
      expect(f.requestCalls).toEqual([]);
    }),
);

it.effect(
  "non-family sends restore standalone targets and preserve grants, exact message references, and parent provenance",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      f.resolve();
      const selectedMessage = messageReference(source, "entry");
      const sent = yield* f.call("sessions.send", {
        sessionId: "s:00000022",
        text: "Review this",
        inputRefs: ["allowed"],
        messageRefs: [selectedMessage],
        expectsResponse: true,
        delivery: "steer",
      });
      expect(sent).toMatchObject({
        ok: true,
        expectsResponse: true,
        delivery: "steer",
        messageNumber: 1,
        target: { sessionId: target },
      });
      const delivered = yield* Queue.take(f.prompts);
      const envelope = parseCrossSessionMessage(delivered.text);
      expect(delivered).toMatchObject({
        sessionId: target,
        delivery: "steer",
        attachments: [{ kind: "forwarded-input", reference: "granted/allowed" }],
      });
      expect(envelope?.metadata).toMatchObject({
        expectsResponse: true,
        sender: {
          sessionId: source,
          kind: "project-session",
          title: "Source",
          workingDirectory: "/project",
        },
      });
      expect(envelope?.text).toContain(selectedMessage);
      expect(f.grants).toContainEqual({ owner: source, refs: ["allowed"], recipient: target });
      expect(f.restored()).toBe(1);
      expect(f.requestCalls).toEqual([]);
      const receipt = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ threadId: Schema.String, messageId: Schema.String }),
      )(sent);
      const reply = yield* f.direct(
        "sessions.reply",
        { text: "Findings", threadId: receipt.threadId },
        { ...caller, sessionId: target, title: "Target" },
      );
      expect(reply).toMatchObject({
        ok: true,
        replyToMessageId: receipt.messageId,
        expectsResponse: false,
        target: { sessionId: source },
      });
      expect(
        yield* f.direct(
          "sessions.thread",
          { threadId: receipt.threadId },
          { ...caller, sessionId: third },
        ),
      ).toMatchObject({ ok: false });
      expect(
        yield* f.direct(
          "sessions.reply",
          { text: "Forged", threadId: receipt.threadId, replyToMessageId: crypto.randomUUID() },
          { ...caller, sessionId: target },
        ),
      ).toMatchObject({ ok: false });
    }),
);

it.effect("rejected attachments or missing exact Pi messages cannot reach delivery", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    expect(
      yield* f
        .call("sessions.send", { sessionId: target, text: "No permission", inputRefs: ["foreign"] })
        .pipe(Effect.exit),
    ).toMatchObject({ _tag: "Failure" });
    expect(
      yield* f
        .call("sessions.send", {
          sessionId: target,
          text: "No message",
          messageRefs: [messageReference(source, "missing")],
        })
        .pipe(Effect.exit),
    ).toMatchObject({ _tag: "Failure" });
    expect(yield* Queue.size(f.prompts)).toBe(0);
  }),
);

it.effect(
  "thread inspection retains factual failed/completed outcomes after immediate settlement and runtime release",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      f.failedTurns.add(target);
      for (const [sessionId, status] of [
        [target, "failed"],
        [third, "delivered"],
      ] as const) {
        const result = yield* f.call("sessions.send", { sessionId, text: "Run" });
        expect(result).toMatchObject({ ok: true, status: "accepted" });
        const { threadId } = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ threadId: Schema.String }),
        )(result);
        // The real runtime marks unread after its settlement hook has recorded the outcome.
        yield* Queue.take(f.saves);
        expect(yield* f.call("sessions.thread", { threadId })).toMatchObject({
          ok: true,
          thread: { messages: [{ status }] },
        });
      }
    }),
);

it.effect("shared thread admission enforces limits across concurrent callers and windows", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const sent = yield* f.call("sessions.send", {
      sessionId: target,
      text: "First",
      maxMessages: 2,
    });
    const { threadId } = yield* Schema.decodeUnknownEffect(
      Schema.Struct({ threadId: Schema.String }),
    )(sent);
    const results = yield* Effect.all(
      [
        f.direct("sessions.send", { sessionId: target, text: "Second", threadId }),
        f.direct("sessions.send", { sessionId: target, text: "Third", threadId }),
      ],
      { concurrency: "unbounded" },
    );
    expect(
      results.filter((result) => Schema.is(jsonObjectSchema)(result) && result.ok),
    ).toHaveLength(1);
    expect(yield* f.direct("sessions.thread", { threadId })).toMatchObject({
      ok: true,
      thread: { state: "closed", messageCount: 2, messages: [{}, {}] },
    });
  }),
);

const cakeControl = Effect.fn("BackendAgentControlTest.cakeControl")(function* (
  f: Effect.Success<ReturnType<typeof fixture>>,
) {
  const options = yield* cakeChatRuntime
    .acquireOptions({
      configuration: {
        location: { workingDirectory: "/home", sessionDirectory: "/cake/global" },
        agentDirectory: "/cake",
      },
      target: { sessionId: CAKE_CHAT_SESSION_ID, tools: backendAgentTools() },
      newSession: false,
    })
    .pipe(Effect.provide(f.context));
  assert.ok(options.runtime.globalControl);
  return options.runtime.globalControl;
});

const batchRegistry = Effect.fn("BackendAgentControlTest.batchRegistry")(function* (
  f: Effect.Success<ReturnType<typeof fixture>>,
) {
  const control = yield* cakeControl(f);
  const registry = new CakeOperationRegistry(
    createGlobalControlOperations(control, () => ({
      provider: "test",
      modelId: "test",
      thinkingLevel: "off",
      fastMode: false,
    })),
  );
  return (command: string, input: JsonObject) =>
    Effect.promise(() =>
      registry.invoke({ command, input }, { signal: signal(), toolCallId: "batch", runtime: {} }),
    );
});

it.effect(
  "backend inspection includes saved Drafts without starting Pi or requiring a window",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const draftId = "00000000-0000-4000-8000-000000000044";
      f.drafts.push({
        sessionId: draftId,
        projectPath: "/project",
        workingDirectory: "/project",
        title: "Unsent",
        text: "Do not execute",
        attachments: [],
        labelIds: [],
        resolved: false,
        createdAt: "2026-01-05",
        modifiedAt: "2026-01-05",
        revision: 1,
        status: "saved",
      });
      expect(yield* f.call("sessions.list")).toMatchObject({
        sessions: [{ sessionId: draftId, draft: true }, {}, {}, {}],
      });
      expect(yield* f.call("sessions.info", { sessionId: draftId })).toMatchObject({
        ok: true,
        session: { sessionId: draftId, draft: true, title: "Unsent", messageCount: 0 },
        status: "idle",
      });
      const added = yield* f.call("session-labels.add", { name: "Draft label", color: "cyan" });
      const { label } = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ label: Schema.Struct({ id: Schema.String }) }),
      )(added);
      expect(
        yield* f.call("sessions.set-labels", { sessionId: draftId, labelIds: [label.id] }),
      ).toMatchObject({ ok: true });
      expect(f.drafts[0]?.labelIds).toEqual([label.id]);
      expect(f.drafts[0]?.revision).toBe(2);
      expect(f.state().projects[0]?.workflow?.assignments ?? []).toEqual([]);
      const current = f.drafts[0];
      assert.ok(current);
      f.drafts[0] = { ...current, status: "activating" };
      expect(
        yield* f.call("sessions.set-labels", { sessionId: draftId, labelIds: [] }),
      ).toMatchObject({ ok: false });
      expect(f.drafts[0]?.labelIds).toEqual([label.id]);
      expect(f.runtimeCreates).not.toContain(draftId);
      expect(yield* Queue.size(f.prompts)).toBe(0);
    }),
);

it.effect("sessions.list preserves Cake Chat launch status, reports, and attention filtering", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const families = Context.get(f.context, SessionFamilyStorage);
    for (const [sessionId, status, summaryText] of [
      [target, "failed", "Typecheck failed"],
      [third, "completed", "Landed abc123"],
    ] as const)
      yield* families.registerSpawn({
        sessionId,
        projectPath: "/project",
        workingDirectory: "/project",
        requester: { kind: "cake-chat", sessionId: CAKE_CHAT_SESSION_ID, title: "Cake Chat" },
        reportDelivered: true,
        handoffSettled: true,
        launchedAt: "2026-01-01",
        lastReport: { status, summary: summaryText, reportedAt: "2026-01-02" },
      });
    expect(yield* f.call("sessions.list", { launchedByCakeChat: true })).toMatchObject({
      sessions: [
        {
          sessionId: target,
          launch: { status: "failed", summary: "Typecheck failed", reportedAt: "2026-01-02" },
        },
        { sessionId: third, launch: { status: "done", summary: "Landed abc123" } },
      ],
      attentionSessions: [{ sessionId: target }],
    });
    for (const status of ["interrupted", "stopped"] as const) {
      yield* families.recordLaunchReport(target, {
        status,
        summary: status,
        reportedAt: "2026-01-03",
      });
      expect(yield* f.call("sessions.list", { launchedByCakeChat: true })).toMatchObject({
        sessions: [{ sessionId: target, launch: { status } }, { sessionId: third }],
        attentionSessions: status === "interrupted" ? [{ sessionId: target }] : [],
      });
    }
    f.pauseMessage();
    yield* f.call("sessions.send", { sessionId: third, text: "Run" });
    yield* Queue.take(f.prompts);
    expect(yield* f.call("sessions.list", { launchedByCakeChat: true })).toMatchObject({
      sessions: [{ sessionId: target }, { sessionId: third, launch: { status: "running" } }],
    });
    yield* Deferred.succeed(f.messageRelease, undefined);
  }),
);

it.effect(
  "disconnect/rebind during Pi admission neither repeats delivery nor loses the thread",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.requests.bind({ _tag: "ProjectSession", sessionId: source }, 11);
      f.pauseAdmission();
      const pending = yield* f
        .call("sessions.send", { sessionId: target, text: "Once" })
        .pipe(Effect.forkChild);
      yield* Queue.take(f.admissions);
      yield* f.requests.releaseConnection(11);
      yield* f.requests.bind({ _tag: "ProjectSession", sessionId: source }, 22);
      yield* Deferred.succeed(f.admissionRelease, undefined);
      const result = yield* Fiber.join(pending);
      expect(yield* Queue.take(f.prompts)).toMatchObject({ sessionId: target });
      const { threadId } = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ threadId: Schema.String }),
      )(result);
      expect(yield* f.call("sessions.thread", { threadId })).toMatchObject({
        ok: true,
        thread: { messageCount: 1, participants: [{ sessionId: source }, { sessionId: target }] },
      });
      expect(yield* Queue.size(f.prompts)).toBe(0);
      expect(f.requestCalls).toEqual([]);
    }),
);

it.effect(
  "backend batch sends retain independent correlation and Cake Chat digest/silent/interrupt policies",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const invoke = yield* batchRegistry(f);
      const result = yield* invoke("sessions.send-batch", {
        sessionIds: [target, third],
        text: "Shared instructions",
        maxMessages: 5,
      });
      expect(result.structuredContent).toMatchObject({
        result: {
          status: "complete",
          expectsResponse: true,
          report: "digest",
          outcomes: [
            { sessionId: target, status: "accepted" },
            { sessionId: third, status: "accepted" },
          ],
        },
      });
      const messages = yield* Effect.forEach([0, 1], () => Queue.take(f.prompts));
      const envelopes = messages.map((message) => parseCrossSessionMessage(message.text)?.metadata);
      for (const envelope of envelopes)
        expect(envelope).toMatchObject({
          expectsResponse: true,
          report: "digest",
          maxMessages: 5,
          sender: { sessionId: CAKE_CHAT_SESSION_ID, kind: "cake-chat" },
        });
      expect(envelopes[0]?.threadId).not.toBe(envelopes[1]?.threadId);
      expect(envelopes[0]?.messageId).not.toBe(envelopes[1]?.messageId);
      expect(result.text).not.toContain("Shared instructions");
      yield* invoke("sessions.send", {
        sessionId: target,
        text: "Single follow-up",
        expectsResponse: false,
      });
      const single = parseCrossSessionMessage((yield* Queue.take(f.prompts)).text)?.metadata;
      expect(single).toMatchObject({ expectsResponse: false });
      expect(single).not.toHaveProperty("report");
      expect(
        (yield* invoke("sessions.send-batch", {
          sessionIds: [target],
          text: "FYI",
          report: "silent",
        })).structuredContent,
      ).toMatchObject({
        result: { expectsResponse: false, report: "silent" },
      });
      yield* Queue.take(f.prompts);
      expect(
        JSON.parse(
          (yield* invoke("sessions.send", { sessionId: third, text: "Ping", report: "interrupt" }))
            .text,
        ),
      ).toMatchObject({
        expectsResponse: true,
        report: "interrupt",
      });
      expect(parseCrossSessionMessage((yield* Queue.take(f.prompts)).text)?.metadata).toMatchObject(
        {
          expectsResponse: true,
          report: "interrupt",
        },
      );
    }),
);

it.effect("backend batches choose prompt for idle and follow-up for busy recipients", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    f.active.add(third);
    f.pauseMessage();
    const invoke = yield* batchRegistry(f);
    expect(
      (yield* invoke("sessions.send-batch", {
        sessionIds: [target, third],
        text: "Ordinary message",
      })).structuredContent,
    ).toMatchObject({
      result: {
        status: "complete",
        outcomes: [
          { sessionId: target, delivery: "prompt", status: "accepted" },
          { sessionId: third, delivery: "queue", status: "queued" },
        ],
      },
    });
    expect(yield* Queue.take(f.prompts)).toMatchObject({ sessionId: target, delivery: "prompt" });
    expect(yield* Queue.take(f.prompts)).toMatchObject({ sessionId: third, delivery: "follow-up" });
    // Accepted turns bridge admission to the first streaming event.
    expect(
      yield* f.call("sessions.send", { sessionId: target, text: "While preparing" }),
    ).toMatchObject({
      delivery: "queue",
      status: "queued",
    });
    yield* Deferred.succeed(f.messageRelease, undefined);
  }),
);

it.effect("backend batches retain failures alongside subsequent successes", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    f.unavailable.add(target);
    const invoke = yield* batchRegistry(f);
    expect(
      (yield* invoke("sessions.send-batch", {
        sessionIds: ["missing", target, third],
        text: "New direction",
        delivery: "steer",
        expectsResponse: false,
      })).structuredContent,
    ).toMatchObject({
      result: {
        status: "partial",
        outcomes: [
          { sessionId: "missing", ok: false, error: "Unknown session reference: missing" },
          { sessionId: target, ok: false, error: expect.stringContaining("Recipient unavailable") },
          { sessionId: third, ok: true, delivery: "steer" },
        ],
      },
    });
    expect(parseCrossSessionMessage((yield* Queue.take(f.prompts)).text)?.metadata).toMatchObject({
      expectsResponse: false,
    });
    expect(yield* Queue.size(f.prompts)).toBe(0);
  }),
);

it.effect("Cake Chat keeps report policy and protected-task redaction without a renderer", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const global = yield* cakeChatRuntime
      .acquireOptions({
        configuration: {
          location: { workingDirectory: "/home", sessionDirectory: "/cake/global" },
          agentDirectory: "/cake",
        },
        target: { sessionId: CAKE_CHAT_SESSION_ID, tools: [] },
        newSession: false,
      })
      .pipe(Effect.provide(f.context));
    const control = global.runtime.globalControl;
    assert.ok(control);
    const call = (name: string, input: JsonObject) =>
      Effect.promise(() => control.invoke({ name, arguments: input }, signal()));
    expect(
      yield* call("settings.instructions.update", { instructions: "Coordinator-owned" }),
    ).toMatchObject({ ok: true, value: { instructions: "Coordinator-owned" } });
    f.protect();
    expect(yield* call("sessions.info", { sessionId: target })).toMatchObject({
      ok: false,
      error: expect.stringContaining("task inputs"),
    });
    const receipt = yield* call("sessions.send", {
      sessionId: target,
      text: "Status?",
      report: "digest",
    });
    expect(receipt).toMatchObject({ ok: true, report: "digest", expectsResponse: true });
    expect(receipt).not.toHaveProperty("targetTitle");
    expect(parseCrossSessionMessage((yield* Queue.take(f.prompts)).text)?.metadata).toMatchObject({
      sender: { kind: "cake-chat", sessionId: CAKE_CHAT_SESSION_ID },
      report: "digest",
      expectsResponse: true,
    });
    expect(
      yield* call("sessions.send", { sessionId: target, text: "Quiet", report: "silent" }),
    ).toMatchObject({ ok: true, report: "silent", expectsResponse: false });
    expect(parseCrossSessionMessage((yield* Queue.take(f.prompts)).text)?.metadata).toMatchObject({
      expectsResponse: false,
    });
    expect(f.requestCalls).toEqual([]);
  }),
);
