import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { TestClock } from "effect/testing";
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
import type { SessionContextMetadata } from "../../../src/contracts/conversations/session-context-metadata";
import { CakeChatConfiguration } from "../../../src/services/pi-durable/CakeChatConfiguration";
import { projectChatSessionId } from "../../../src/domain/cake-chats/cakeChatLocations";
import { CAKE_CHAT_SESSION_ID } from "../../../src/contracts/cake-chats/cake-chat-identity";
import {
  messageReference,
  parseSessionLink,
} from "../../../src/contracts/conversations/message-reference";
import * as projectTodos from "../../../src/domain/projects/projectTodos";
import { parseCrossSessionMessage } from "../../../src/contracts/conversations/cross-session-message";
import type { WorktreeRecord } from "../../../src/contracts/worktrees/managed-worktree-data";
import type { SavedDraft } from "../../../src/contracts/project-sessions/saved-draft-data";
import { ProjectAccess } from "../../../src/services/projects/ProjectAccess";
import { SavedDraftStorage } from "../../../src/services/storage/SavedDraftStorage";
import { backendAgentTools } from "../../../src/contracts/application/backend-agent-tools";
import { CakeOperationRegistry } from "../../../src/services/pi/runtime/cake-operation-registry";
import { projectCakeOperations } from "../../../src/layers/CakeOperations";
import { setCakeChatPreferences, upsertProject } from "../../../src/domain/application/application";
import { defaultCakeChatPreferences } from "../../../src/contracts/cake-chats/cake-chat-preferences";
import { createGlobalControlOperations } from "../../../src/domain/application/cake-global-control-operations";
import type { Attachment } from "../../../src/contracts/conversations/session-contract";
import { AttachmentUploadError } from "../../../src/contracts/filesystem/attachment-uploads-errors";
import type { CakeEvent } from "../../../src/contracts/application/cake-rpc-contract";
import { acquireOptions } from "../../../src/domain/project-sessions/projectSessionRuntime";
import * as cakeChatRuntime from "../../../src/domain/cake-chats/cakeChatRuntime";
import * as agentControl from "../../../src/domain/application/agentControl";
import { ApplicationState } from "../../../src/services/storage/ApplicationState";
import { ApplicationStorage } from "../../../src/services/storage/ApplicationStorage";
import { ApplicationWriteError } from "../../../src/contracts/storage/application-storage-errors";
import { TaskInputStorage } from "../../../src/services/storage/TaskInputStorage";
import {
  SessionArchiveStorage,
  SessionArchiveStorageError,
  type ProjectSessionArchiveMetadata,
} from "../../../src/services/storage/SessionArchiveStorage";
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
import {
  makeRuntimeRecoveryStorageTestLayer,
  fakeRuntime,
  snapshot,
} from "../helpers/piRuntimeFixture";
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

const fixture = Effect.fn("BackendAgentControlTest.fixture")(function* (withChats = false) {
  const compactions: Array<{ sessionId: string; instructions?: string }> = [];
  const compactFailures = new Set<string>();
  const compacted = new Set<string>();
  const compactStarted = yield* Deferred.make<void>();
  const compactRelease = yield* Deferred.make<void>();
  let pauseCompaction = false;
  const prompts = yield* Queue.unbounded<{
    sessionId: string;
    text: string;
    delivery: string;
    attachments: readonly Attachment[];
  }>();
  const saves = yield* Queue.unbounded<void>();
  const saveRelease = yield* Deferred.make<void>();
  let pauseSave = false;
  let failNextSave = false;
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
  const inspections: string[] = [];
  const listReads = {
    ids: [] as string[],
    titles: [] as string[],
    entries: [] as string[],
    locate: 0,
    resolutions: [] as string[],
    drafts: 0,
    records: 0,
  };
  const sessionsByDirectory = new Map<string, string[]>([["/project", [source, target, third]]]);
  const archivedEntries = new Map<string, ProjectSessionArchiveMetadata>();
  const worktreeRecords: WorktreeRecord[] = [];
  const contextBySession = new Map<string, SessionContextMetadata>();
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
          if (failNextSave) {
            failNextSave = false;
            return yield* new ApplicationWriteError({
              stage: "write",
              message: "Injected storage failure",
            });
          }
        }),
    }),
  );
  const clients = Layer.merge(ClientConnectionsLive, ClientEventsLive);
  const renderers = RendererRequestCoordinatorLive.pipe(Layer.provideMerge(clients));
  const runtimes = makeCakeSessionRuntimesLayer({
    sessionIds: (query) => {
      listReads.ids.push(query.workingDirectory);
      return Stream.fromIterable(sessionsByDirectory.get(query.workingDirectory) ?? []);
    },
    catalog: (query) => {
      const ids = (sessionsByDirectory.get(query.workingDirectory) ?? []).filter(
        (id) => !unavailable.has(id) && !query.excludedSessionIds?.includes(id),
      );
      listReads.titles.push(...ids);
      return Stream.fromIterable(ids.map(summary));
    },
    catalogEntry: (_query, id) => {
      listReads.entries.push(id);
      return unavailable.has(id)
        ? Effect.fail(
            new PiSessionError({ operation: "catalogEntry", message: "Recipient unavailable" }),
          )
        : Effect.succeed(
            [source, target, third].includes(id) || contextBySession.has(id)
              ? { ...summary(id), contextMetadata: contextBySession.get(id) }
              : undefined,
          );
    },
    inspect: ({ sessionId }) =>
      Effect.sync(() => {
        inspections.push(sessionId);
        return {
          workspacePath: "/project",
          sessionId,
          sessionFile: `/cake/sessions/${sessionId}.jsonl`,
          contextMetadata: contextBySession.get(sessionId),
          parts: [
            {
              id: "entry",
              kind: "text" as const,
              role: "user" as const,
              text: "First input",
              status: "complete" as const,
            },
          ],
        };
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
          compactIfIdle: async (instructions) => {
            compactions.push({
              sessionId,
              ...(instructions === undefined ? null : { instructions }),
            });
            Deferred.doneUnsafe(compactStarted, Effect.void);
            if (pauseCompaction) await Effect.runPromise(Deferred.await(compactRelease));
            if (compactFailures.has(sessionId)) throw new Error("Compaction provider failed");
            if (compacted.has(sessionId)) return { status: "unchanged" };
            compacted.add(sessionId);
            return { status: "compacted" };
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
  }).pipe(Layer.provide(makeRuntimeRecoveryStorageTestLayer()));
  const dependencies = Layer.mergeAll(
    WorkflowTestLive,
    withChats
      ? Layer.succeed(CakeChatConfiguration, {
          location: { workingDirectory: "/chat", sessionDirectory: "/chats" },
          agentDirectory: "/agent",
        })
      : Layer.empty,
    Layer.mock(SavedDraftStorage, {
      list: () =>
        Effect.sync(() => {
          listReads.drafts++;
          return drafts;
        }),
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
      records: () =>
        Effect.sync(() => {
          listReads.records++;
          return worktreeRecords;
        }),
      awaitSetup: () => Effect.void,
    }),
    Layer.mock(SessionArchiveStorage, {
      resolvedProjectEntry: (id) => Effect.succeed(archivedEntries.get(id)),
      resolvedEntry: (id) => Effect.succeed(summary(id)),
      resolvedProjects: (path) =>
        Stream.fromIterable(
          [...archivedEntries.values()].filter((entry) => entry.projectPath === path),
        ),
      recordedResolvedIds: () => Effect.succeed(new Set(resolved ? [target] : [])),
      resolvedIds: (at) =>
        Effect.sync(() => {
          listReads.resolutions.push(at.cwd);
          return new Set(resolved ? [target] : []);
        }),
      locate: (id, at) => {
        listReads.locate++;
        return Effect.succeed(
          !sessionsByDirectory.get(at.cwd)?.includes(id)
            ? undefined
            : resolved && id === target
              ? ("resolved" as const)
              : ("active" as const),
        );
      },
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
    compactions,
    compactFailures,
    compactStarted,
    compactRelease,
    pauseCompaction: () => {
      pauseCompaction = true;
    },
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
    inspections,
    contextBySession,
    listReads,
    sessionsByDirectory,
    archivedEntries,
    worktreeRecords,
    saves,
    saveRelease,
    call: (command: string, input: JsonObject = {}) =>
      Effect.promise(() => invoke(command, input, signal())),
    direct: (command: string, input: JsonValue, sender: agentControl.AgentControlCaller = caller) =>
      agentControl.invoke(command, input, sender).pipe(Effect.provide(context)),
    state: () => Context.get(context, ApplicationState).snapshot(),
    pause: () => {
      pauseSave = true;
    },
    saveCount: () => saveCount,
    failNextSave: () => {
      failNextSave = true;
    },
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
  "compacts an authorized target through backend controls and awaits runtime completion",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      f.pauseCompaction();
      const operation = yield* f
        .call("sessions.compact", { sessionId: "00000022", instructions: "Keep decisions" })
        .pipe(Effect.forkScoped);
      yield* Deferred.await(f.compactStarted);
      expect(operation.pollUnsafe()).toBeUndefined();
      expect(f.compactions).toEqual([{ sessionId: target, instructions: "Keep decisions" }]);
      yield* Deferred.succeed(f.compactRelease, undefined);
      expect(yield* Fiber.join(operation)).toMatchObject({
        ok: true,
        command: "sessions.compact",
        results: [{ reference: "00000022", sessionId: target, status: "compacted" }],
      });
      expect(yield* f.call("sessions.compact", { sessionId: target })).toMatchObject({
        ok: true,
        results: [{ status: "unchanged" }],
      });
      expect(f.requestCalls).toEqual([]);
      expect(f.restored()).toBe(0);
      expect(f.saveCount()).toBe(0);
    }),
);

it.effect(
  "bulk compaction preserves order, deduplicates aliases and retains partial failures",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      f.compactFailures.add(third);
      const sessionIds = [target, "00000022", "not-a-session", third, third, source];
      expect(yield* f.call("sessions.compact-batch", { sessionIds })).toMatchObject({
        ok: false,
        results: [
          { reference: target, sessionId: target, status: "compacted" },
          { reference: "00000022", sessionId: target, status: "compacted", duplicateOf: 0 },
          { reference: "not-a-session", status: "invalid" },
          {
            reference: third,
            sessionId: third,
            status: "failed",
            message: "Compaction provider failed",
          },
          { reference: third, status: "failed", duplicateOf: 3 },
          { reference: source, status: "compacted" },
        ],
      });
      expect(f.compactions.map((item) => item.sessionId)).toEqual([target, third, source]);
      expect(f.requestCalls).toEqual([]);
    }),
);

it.effect("skips busy targets and compacts accessible resolved history without restore", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* f.direct("sessions.context", { sessionId: target });
    f.active.add(target);
    expect(yield* f.call("sessions.compact", { sessionId: target })).toMatchObject({
      ok: false,
      results: [{ status: "busy" }],
    });
    f.active.delete(target);
    f.resolve();
    expect(yield* f.call("sessions.compact", { sessionId: target })).toMatchObject({
      ok: true,
      results: [{ status: "compacted" }],
    });
    expect(f.compactions).toEqual([{ sessionId: target }]);
    expect(f.restored()).toBe(0);
    expect(f.saveCount()).toBe(0);
  }),
);

it.effect(
  "Project Chat compaction is project-scoped; global Cake Chat still requires path authorization",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture(true);
      const project = f.state().projects[0];
      assert.ok(project);
      yield* Context.get(f.context, ApplicationState).transact((state) =>
        Effect.succeed({
          ...state,
          projects: [...state.projects, { ...project, path: "/other", name: "Other" }],
        }),
      );
      f.sessionsByDirectory.set("/other", [third]);
      f.sessionsByDirectory.set("/project", [source, target]);
      const projectChat = {
        kind: "cake-chat" as const,
        sessionId: projectChatSessionId("/project"),
        title: "Project Chat",
      };
      for (const sender of [
        caller,
        projectChat,
        { ...projectChat, sessionId: projectChatSessionId("/unknown") },
      ]) {
        expect(
          yield* f.direct("sessions.compact-batch", { sessionIds: [third, target] }, sender),
        ).toMatchObject({
          ok: false,
          results: [
            { status: "unauthorized" },
            {
              status:
                sender.sessionId === projectChatSessionId("/unknown")
                  ? "unauthorized"
                  : sender === caller
                    ? "compacted"
                    : "unchanged",
            },
          ],
        });
      }
      const global = {
        kind: "cake-chat" as const,
        sessionId: CAKE_CHAT_SESSION_ID,
        title: "Cake Chat",
      };
      f.deny("/other");
      expect(yield* f.direct("sessions.compact", { sessionId: third }, global)).toMatchObject({
        ok: false,
        results: [{ status: "unauthorized" }],
      });
      expect(f.compactions.every((item) => item.sessionId === target)).toBe(true);
      // A different, authorized project is reachable only from the global caller.
      f.sessionsByDirectory.set("/third-project", [third]);
      f.sessionsByDirectory.delete("/other");
      yield* Context.get(f.context, ApplicationState).transact((state) =>
        Effect.succeed({
          ...state,
          projects: [...state.projects, { ...project, path: "/third-project", name: "Third" }],
        }),
      );
      expect(yield* f.direct("sessions.compact", { sessionId: third }, global)).toMatchObject({
        ok: true,
        results: [{ status: "compacted" }],
      });
    }),
);

it.effect("compacts resolved family child history without migrating its resolution metadata", () =>
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
    f.resolve();
    const archive = Context.get(f.context, SessionArchiveStorage);
    const result = yield* agentControl
      .invoke("sessions.compact", { sessionId: third }, caller)
      .pipe(
        Effect.provideService(SessionArchiveStorage, {
          ...archive,
          locate: (id, at) =>
            id === third ? Effect.succeed("resolved" as const) : archive.locate(id, at),
        }),
        Effect.provide(f.context),
      );
    expect(result).toMatchObject({
      ok: true,
      results: [{ sessionId: third, status: "compacted" }],
    });
    expect(f.restored()).toBe(0);
  }),
);

it.effect(
  "retired worktrees and saved drafts are unavailable without any runtime acquisition",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      f.worktreeRecords.push({
        worktreePath: "/retired",
        projectPath: "/project",
        branch: "agent/retired",
        baseBranch: "main",
        createdAt: "2026-01-01",
        state: "resolved",
      });
      f.sessionsByDirectory.set("/project", [source, third]);
      f.sessionsByDirectory.set("/retired", [target]);
      f.archivedEntries.set(target, {
        version: 2,
        sessionId: target,
        projectPath: "/project",
        projectName: "Project",
        workingDirectory: "/retired",
        activeRoot: "/cake/sessions",
        resolvedRoot: "/cake/resolved",
        createdAt: "2026-01-01",
        modifiedAt: "2026-01-01",
        worktreeName: "retired",
      });
      f.drafts.push({
        sessionId: "00000000-0000-4000-8000-00000000abcd",
        projectPath: "/project",
        workingDirectory: "/project",
        title: "Saved",
        text: "Not activated",
        attachments: [],
        labelIds: [],
        resolved: false,
        createdAt: "2026-01-01",
        modifiedAt: "2026-01-01",
        revision: 1,
        status: "saved",
      });
      expect(
        yield* f.call("sessions.compact-batch", {
          sessionIds: [target, "0000abcd", "00000000-0000-4000-8000-00000000ffff"],
        }),
      ).toMatchObject({
        ok: false,
        results: [{ status: "unavailable" }, { status: "unavailable" }, { status: "invalid" }],
      });
      expect(f.runtimeCreates).toEqual([source]);
      expect(f.compactions).toEqual([]);
      expect(f.restored()).toBe(0);
    }),
);

it.effect(
  "completed to-do associations can drive an explicit batch without automatic compaction or lifecycle edits",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const created = yield* projectTodos
        .create("/project", {
          title: "Completed work",
          description: "A completed user request.",
          associations: [
            { kind: "session", sessionId: target, title: "Implementation" },
            { kind: "source", ref: messageReference(third, "entry"), title: "Report" },
          ],
        })
        .pipe(Effect.provide(f.context));
      yield* projectTodos
        .update("/project", { id: created.id, expectedRevision: 0, state: "done" })
        .pipe(Effect.provide(f.context));
      const todos = yield* projectTodos.list("/project").pipe(Effect.provide(f.context));
      const sessionIds = todos.items
        .filter((item) => item.state === "done")
        .flatMap((item) =>
          item.associations.flatMap((link) => {
            const id =
              link.kind === "session" ? link.sessionId : parseSessionLink(link.ref)?.sessionId;
            return id ? [id] : [];
          }),
        );
      expect(sessionIds).toEqual([target, third]);
      expect(f.compactions).toEqual([]);
      const saveCount = f.saveCount();
      const projectChat = {
        kind: "cake-chat" as const,
        sessionId: projectChatSessionId("/project"),
        title: "Project Chat",
      };
      expect(yield* f.direct("sessions.compact-batch", { sessionIds }, projectChat)).toMatchObject({
        ok: true,
        results: [
          { sessionId: target, status: "compacted" },
          { sessionId: third, status: "compacted" },
        ],
      });
      expect(yield* projectTodos.list("/project").pipe(Effect.provide(f.context))).toEqual(todos);
      expect(f.saveCount()).toBe(saveCount);
      expect(f.restored()).toBe(0);
    }),
);

it.effect("compaction is discoverable in permanent chat tools with bounded bulk inputs", () =>
  Effect.gen(function* () {
    const tools = backendAgentTools();
    for (const command of ["sessions.compact", "sessions.compact-batch"]) {
      const tool = tools.find((item) => item.command === command);
      expect(tool?.guidance?.join(" ")).toContain("todos.list/read");
      expect(tool?.guidance?.join(" ")).toContain("never aborted or queued");
      expect(tool?.examples?.length).toBeGreaterThan(0);
    }
    const f = yield* fixture();
    for (const sessionIds of [[], Array.from({ length: 101 }, () => target)]) {
      const result = yield* f.direct("sessions.compact-batch", { sessionIds }).pipe(Effect.result);
      expect(result._tag).toBe("Failure");
    }
    expect(f.compactions).toEqual([]);
  }),
);

it.effect(
  "routes scoped report discovery, bounded reads and explicit handling through real agent controls",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const storage = Context.get(f.context, SessionFamilyStorage);
      yield* storage.deferReferenceNotice({
        id: "report-1",
        recipientSessionId: caller.sessionId,
        text: "Exact worker handoff evidence",
      });
      yield* storage.deferReferenceNotice({
        id: "other-report",
        recipientSessionId: "other-chat",
        text: "Private other handoff",
      });
      const listing = yield* f.call("sessions.reports");
      assert.ok(listing && typeof listing === "object" && "total" in listing);
      assert.equal(listing.total, 1);
      assert.ok(!JSON.stringify(listing).includes("Exact worker handoff"));
      const read = yield* f.call("sessions.reports.read", { id: "report-1", offset: 6, limit: 6 });
      assert.ok(read && typeof read === "object" && "text" in read && "nextOffset" in read);
      assert.equal(read.text, "worker");
      assert.equal(read.nextOffset, 12);
      assert.equal(
        (yield* Effect.result(f.direct("sessions.reports.read", { id: "other-report" })))._tag,
        "Failure",
      );
      assert.equal(
        (yield* Effect.result(
          f.direct("sessions.reports.acknowledge", {
            ids: ["report-1"],
            disposition: "communicated",
            communicatedText: "A planned answer",
          }),
        ))._tag,
        "Failure",
      );
      assert.equal((yield* storage.state()).deferredReferences?.length, 2);
    }),
);

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

it.effect("bounds label discovery and filters project/name before pagination", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    for (let index = 0; index < 24; index++) {
      yield* f.call("session-labels.add", {
        name: `Label ${index}`,
        color: "cyan",
        ...(index % 2 ? { projectPath: "/project" } : {}),
      });
    }
    const first = yield* f.call("session-labels.list");
    const decoded = yield* Schema.decodeUnknownEffect(
      Schema.Struct({
        total: Schema.Int,
        nextOffset: Schema.NullOr(Schema.Int),
        labels: Schema.Array(Schema.Unknown),
      }),
    )(first);
    expect(decoded.total).toBe(24);
    expect(decoded.labels).toHaveLength(20);
    expect(decoded.nextOffset).toBe(20);
    expect(yield* f.call("session-labels.list", { offset: 20, limit: 50 })).toMatchObject({
      total: 24,
      offset: 20,
      nextOffset: null,
    });
    expect(
      yield* f.call("session-labels.list", {
        projectPath: "/unregistered",
        query: "Label 1",
        limit: 2,
        offset: 1,
      }),
    ).toMatchObject({
      total: 5,
      offset: 1,
      nextOffset: 3,
      labels: [{ name: "Label 12" }, { name: "Label 14" }],
    });
    expect(yield* f.call("session-labels.list", { query: "absent" })).toMatchObject({
      total: 0,
      nextOffset: null,
      labels: [],
    });
    expect(yield* f.call("session-labels.list", { limit: 51 }).pipe(Effect.exit)).toMatchObject({
      _tag: "Failure",
    });
  }),
);

it.effect(
  "lets coding sessions explicitly update only their registered Project Chat with readback and live authorization",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* upsertProject("/other", "Other").pipe(Effect.provide(f.context));
      yield* setCakeChatPreferences({
        ...defaultCakeChatPreferences(),
        instructions: "Existing shared Zombie Madness rule must stay.",
      }).pipe(Effect.provide(f.context));
      yield* f.call("project.settings.update", {
        changes: {
          customInstructions: "Existing coding guidance.",
          projectChatInstructions: "Original chat guidance.",
        },
      });
      f.deny("/worktrees/coding-session");
      const options = yield* acquireOptions({
        location: { ...location, workingDirectory: "/worktrees/coding-session" },
        sessionId: source,
        newSession: false,
      }).pipe(Effect.provide(f.context));
      const registry = new CakeOperationRegistry(
        projectCakeOperations(options.runtime)({
          host: { appendEntry: () => undefined },
          api: () => {
            throw new Error("No renderer or shared-instruction fallback is permitted");
          },
          sessionId: () => source,
          publishSnapshot: async () => undefined,
          getAvailableOfType: async () => [],
        }),
      );
      const context = {
        signal: signal(),
        toolCallId: "project-guidance",
        runtime: { sessionId: source, assistantEntryId: "assistant" },
      };
      const read = yield* Effect.promise(() =>
        registry.invoke(
          {
            command: "settings.project-chat.get",
            input: { projectPath: "/project" },
          },
          context,
        ),
      );
      expect(read.details).toMatchObject({
        result: { projectPath: "/project", instructions: "Original chat guidance." },
      });
      expect(registry.operationHelp("settings.project-chat.update")).toContain(
        "Never silently substitute settings.cake-chat.update",
      );
      const input = {
        projectPath: "/project",
        expectedInstructions: "Original chat guidance.",
        instructions:
          "Original chat guidance. Shared checkout unless explicitly asked for a worktree.",
      };
      const saved = yield* Effect.promise(() =>
        registry.invoke({ command: "settings.project-chat.update", input }, context),
      );
      expect(saved.details).toMatchObject({
        result: { projectPath: "/project", instructions: input.instructions },
      });
      const readback = yield* Effect.promise(() =>
        registry.invoke(
          { command: "settings.project-chat.get", input: { projectPath: "/project" } },
          context,
        ),
      );
      expect(readback.details).toMatchObject({ result: { instructions: input.instructions } });
      expect(yield* f.call("project.settings.get")).toMatchObject({
        projectPath: "/project",
        settings: {
          projectChatInstructions: input.instructions,
          customInstructions: "Existing coding guidance.",
        },
      });
      expect(options.runtime.additionalSystemPrompt).not.toContain(input.instructions);
      expect(f.state().cakeChatPreferences?.instructions).toBe(
        "Existing shared Zombie Madness rule must stay.",
      );
      expect(f.state().projects.find((p) => p.path === "/other")?.settings).toBeUndefined();
      yield* Effect.promise(() =>
        expect(
          registry.invoke({ command: "settings.project-chat.update", input }, context),
        ).rejects.toThrow(/changed/),
      );
      for (const projectPath of ["/other", "/worktrees/coding-session", "/missing"]) {
        yield* Effect.promise(() =>
          expect(
            registry.invoke(
              { command: "settings.project-chat.get", input: { projectPath } },
              context,
            ),
          ).rejects.toThrow(/calling conversation/),
        );
        yield* Effect.promise(() =>
          expect(
            registry.invoke(
              {
                command: "settings.project-chat.update",
                input: { ...input, projectPath, expectedInstructions: "" },
              },
              context,
            ),
          ).rejects.toThrow(/calling conversation/),
        );
      }
      f.failNextSave();
      yield* Effect.promise(() =>
        expect(
          registry.invoke(
            {
              command: "settings.project-chat.update",
              input: {
                ...input,
                expectedInstructions: input.instructions,
                instructions: "Not persisted.",
              },
            },
            context,
          ),
        ).rejects.toThrow(/Injected storage failure/),
      );
      const afterFailure = yield* Effect.promise(() =>
        registry.invoke(
          { command: "settings.project-chat.get", input: { projectPath: "/project" } },
          context,
        ),
      );
      expect(afterFailure.details).toMatchObject({ result: { instructions: input.instructions } });
      f.deny("/project");
      const saves = f.saveCount();
      yield* Effect.promise(() =>
        expect(
          registry.invoke(
            {
              command: "settings.project-chat.update",
              input: {
                ...input,
                expectedInstructions: input.instructions,
                instructions: "Not authorized.",
              },
            },
            context,
          ),
        ).rejects.toThrow(/not selected by the user/),
      );
      expect(f.saveCount()).toBe(saves);
      expect(
        f.state().projects.find((p) => p.path === "/project")?.settings?.projectChatInstructions,
      ).toBe(input.instructions);
      expect(f.requestCalls).toEqual([]);
    }),
);

it.effect("sessionInfoReusesAuthoritativeRoute", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    for (let i = 0; i < 4; i++)
      f.worktreeRecords.push({
        worktreePath: `/unrelated-${i}`,
        projectPath: "/project",
        branch: `agent/unrelated-${i}`,
        baseBranch: "main",
        createdAt: "2026-01-01",
      });
    const before = {
      records: f.listReads.records,
      locate: f.listReads.locate,
      entries: f.listReads.entries.length,
      ids: f.listReads.ids.length,
      creates: f.runtimeCreates.length,
    };
    expect(yield* f.direct("sessions.info", { sessionId: target })).toMatchObject({
      ok: true,
      session: {
        sessionId: target,
        workspacePath: "/project",
        deepLink: `cake://session/${target}`,
        lifecycle: "active",
        resolved: false,
      },
      status: "idle",
    });
    // One collision-checked route search, then one authoritative namespace check.
    expect(f.listReads.locate - before.locate).toBe(6);
    expect(f.listReads.records - before.records).toBe(1);
    expect(f.listReads.entries.slice(before.entries)).toEqual([]);
    expect(f.listReads.ids.length - before.ids).toBe(0);
    expect(f.inspections).toEqual([]);
    expect(f.runtimeCreates.length).toBe(before.creates);
  }),
);

it.effect("canonical session info retains authoritative existence validation", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    expect(
      yield* Effect.flip(
        f.direct("sessions.info", { sessionId: "00000000-0000-4000-8000-00000000ffff" }),
      ),
    ).toMatchObject({ message: expect.stringContaining("could not find Project Session") });
    expect(f.inspections).toEqual([]);
  }),
);

it.effect("session info rejects canonical identity location collisions before inspection", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    f.worktreeRecords.push({
      worktreePath: "/collision",
      projectPath: "/project",
      branch: "agent/collision",
      baseBranch: "main",
      createdAt: "2026-01-01",
    });
    const archive = Context.get(f.context, SessionArchiveStorage);
    const context = Context.add(f.context, SessionArchiveStorage, {
      ...archive,
      locate: (id, at) =>
        id === target ? Effect.succeed("active" as const) : archive.locate(id, at),
    });
    expect(
      yield* Effect.flip(
        agentControl
          .invoke("sessions.info", { sessionId: target }, caller)
          .pipe(Effect.provide(context)),
      ),
    ).toMatchObject({ message: `Project Session ID collision detected: ${target}` });
    expect(f.inspections).toEqual([]);
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
        changes: { customInstructions: "Project-owned", projectChatInstructions: "Chat-owned" },
      }),
    ).toMatchObject({
      ok: true,
      settings: { customInstructions: "Project-owned", projectChatInstructions: "Chat-owned" },
    });
    expect(yield* f.call("project.settings.get", {})).toMatchObject({
      projectPath: "/project",
      settings: { customInstructions: "Project-owned", projectChatInstructions: "Chat-owned" },
    });
    yield* f.call("project.settings.update", {
      changes: { customInstructions: "Updated coding only" },
    });
    expect(yield* f.call("project.settings.get", {})).toMatchObject({
      settings: {
        customInstructions: "Updated coding only",
        projectChatInstructions: "Chat-owned",
      },
    });
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
        lifecycle: "active",
        resolved: false,
      },
    });
    yield* f.call("session-labels.update", { labelId, name: "Ready" });
    yield* f.call("session-labels.reorder", { labelId, index: 0 });
    expect(yield* f.call("session-labels.list")).toMatchObject({
      labels: [{ id: labelId, name: "Ready" }],
    });
    yield* f.call("session-labels.remove", { labelId });
    expect(f.state().projects[0]?.workflow?.assignments[0]?.labelIds ?? []).toEqual([]);
    expect(yield* f.call("sessions.list")).toBe(
      "3 sessions\nid status lifecycle outcome tokens cache age ttl | title\n00000022 idle active - ? ? ? ? | Same title\n00000011 idle active - ? ? ? ? | Source\n00000033 idle active - ? ? ? ? | Same title",
    );
    for (const command of ["history", "compactions", "tree", "context", "usage", "commands"])
      expect(yield* f.call(`sessions.${command}`, { sessionId: "00000022" })).toMatchObject({
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
        sessionId: "00000022",
        text: "Review this",
        inputRefs: ["allowed"],
        messageRefs: [selectedMessage],
        resultDelivery: "reply",
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
      expect(yield* f.call("sessions.list")).toContain("draft draft - ? ? ? ? | Unsent");
      expect(yield* f.call("sessions.info", { sessionId: draftId })).toMatchObject({
        ok: true,
        session: { sessionId: draftId, draft: true, lifecycle: "draft", resolved: false },
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

it.effect(
  "lists compact size and freshness only for the selected page without waking sessions",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* TestClock.setTime(Date.parse("2000-01-01T01:00:00.000Z"));
      f.contextBySession.set(target, {
        estimatedTokens: 120_000,
        lastModelActivityAt: "2000-01-01T00:00:00.000Z",
        cacheObservation: {
          provider: "anthropic",
          observedAt: "2000-01-01T00:00:00.000Z",
          readTokens: 0,
          writeTokens: 10_000,
          write1hTokens: 0,
        },
      });
      expect(yield* f.call("sessions.list", { limit: 1 })).toBe(
        "3 sessions; next=1\nid status lifecycle outcome tokens cache age ttl | title\n00000022 idle active - 120K expired? 1h -55m | Same title",
      );
      expect(f.inspections).toEqual([target]);
      expect(f.runtimeCreates).toEqual([source]);
      expect(yield* Queue.size(f.prompts)).toBe(0);
      expect(yield* f.call("sessions.info", { sessionId: target })).toMatchObject({
        session: {
          sessionId: target,
          resolved: false,
        },
      });
    }),
);

it.effect(
  "exposes committed-head metadata for Project Chat and global Cake Chat without opening either",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture(true);
      const projectChat = projectChatSessionId("/project");
      for (const id of [CAKE_CHAT_SESSION_ID, projectChat])
        f.contextBySession.set(id, { estimatedTokens: 1234 });
      const listing = yield* f.direct(
        "sessions.list",
        { query: "Chat" },
        { kind: "cake-chat", sessionId: CAKE_CHAT_SESSION_ID, title: "Cake Chat" },
      );
      expect(listing).toContain(
        "2 sessions\nid status lifecycle outcome tokens cache age ttl | project | title",
      );
      expect(listing).toContain("cake-chat idle active - 1.2K ? ? ? | — | Cake Chat");
      expect(listing).toContain("idle active - 1.2K ? ? ? | Project | Project Chat");
      const entries = f.listReads.entries.length;
      for (const sessionId of [CAKE_CHAT_SESSION_ID, projectChat])
        expect(yield* f.direct("sessions.info", { sessionId })).toMatchObject({
          ok: true,
          session: {
            sessionId,
            deepLink: `cake://session/${encodeURIComponent(sessionId)}`,
            lifecycle: "active",
            resolved: false,
          },
        });
      expect(f.listReads.entries.length).toBe(entries);
      expect(f.inspections).toEqual([]);
      expect(f.runtimeCreates).toEqual([source]);
    }),
);

it.effect(
  "limits every non-global caller to its project, including worktree callers and explicit filters",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture(true);
      const project = f.state().projects[0];
      assert.ok(project);
      yield* Context.get(f.context, ApplicationState).transact((state) =>
        Effect.succeed({
          ...state,
          projects: [...state.projects, { ...project, path: "/other", name: "Other" }],
        }),
      );
      f.drafts.push({
        sessionId: "00000000-0000-4000-8000-00000000abcd",
        projectPath: "/other",
        workingDirectory: "/other-worktree",
        title: "Foreign task",
        text: "Private draft body",
        attachments: [],
        labelIds: [],
        resolved: false,
        createdAt: "2026-02-01",
        modifiedAt: "2026-02-01",
        revision: 1,
        status: "saved",
      });
      const global = {
        kind: "cake-chat" as const,
        sessionId: CAKE_CHAT_SESSION_ID,
        title: "Cake Chat",
      };
      expect(yield* f.direct("sessions.list", { query: "Foreign" }, global)).toContain(
        "0000abcd draft draft - ? ? ? ? | Other | Foreign task",
      );
      expect(
        yield* f.direct("sessions.list", { query: "Foreign", projectPath: "/other" }, global),
      ).toContain("0000abcd draft draft - ? ? ? ? | Foreign task");
      const projectChat = {
        kind: "cake-chat" as const,
        sessionId: projectChatSessionId("/project"),
        title: "Project Chat",
      };
      for (const sender of [
        caller,
        { ...caller, workingDirectory: "/managed-worktree" },
        { ...caller, projectPath: undefined },
        projectChat,
      ]) {
        expect(yield* f.direct("sessions.list", { query: "Foreign" }, sender)).toBe("0 sessions");
        expect(yield* f.direct("sessions.list", { projectPath: "/other" }, sender)).toBe(
          "0 sessions",
        );
        expect(yield* f.direct("sessions.list", { query: "Same" }, sender)).toContain(
          "00000022 idle active - ? ? ? ? | Same title",
        );
      }
      expect(
        yield* f.direct(
          "sessions.list",
          {},
          { ...projectChat, sessionId: projectChatSessionId("/unregistered") },
        ),
      ).toMatchObject({
        ok: false,
        error: "The caller has no registered project scope.",
      });
      expect(f.runtimeCreates).toEqual([source]);
    }),
);

it.effect("keeps task-input metadata redacted in session and report text catalogs", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    f.protectedSessions.add(target);
    const global = {
      kind: "cake-chat" as const,
      sessionId: CAKE_CHAT_SESSION_ID,
      title: "Cake Chat",
    };
    expect(yield* f.direct("sessions.list", { query: "Task" }, global)).toBe(
      "1 sessions\nid status lifecycle outcome tokens cache age ttl | project | title\n00000022 idle active - ? ? ? ? | Project | Task session",
    );
    const invoke = yield* batchRegistry(f);
    const expected =
      "1 sessions\nid status lifecycle outcome tokens cache age ttl | project | title\n00000022 idle active - ? ? ? ? | Project | Task session";
    expect(yield* invoke("sessions.list", { query: "Task" })).toMatchObject({
      text: expected,
      structuredContent: expected,
      details: { result: expected },
    });
    const unprotected = yield* f.direct("sessions.list", { query: "Same" }, global);
    expect(unprotected).toContain("00000033");
    expect(unprotected).not.toContain("00000022");
    const storage = Context.get(f.context, SessionFamilyStorage);
    yield* storage.deferReferenceNotice({
      id: "protected-report",
      recipientSessionId: CAKE_CHAT_SESSION_ID,
      text: "PRIVATE_REPORT_BODY",
      source: {
        kind: "subagent",
        handleId: "PRIVATE_HANDLE",
        sessionId: target,
        task: "PRIVATE_TASK",
        status: "done",
      },
    });
    const report = yield* invoke("sessions.reports", {});
    expect(report.text).toBe(
      `1 pending reports\nid\tadmissions\tsession\thandle\tstatus\ttask\nprotected-report\t0\t${target}\t-\tdone\tTask session`,
    );
    expect(JSON.stringify(report)).not.toContain("PRIVATE_");
    expect((yield* storage.state()).deferredReferences).toHaveLength(1);
    expect(f.runtimeCreates).toEqual([source]);
  }),
);

it.effect("lists a 699-location roster with one snapshot and no per-session route probes", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const project = f.state().projects[0];
    assert.ok(project);
    yield* Context.get(f.context, ApplicationState).transact((state) =>
      Effect.succeed({
        ...state,
        projects: [...state.projects, { ...project, path: "/other", name: "Other" }],
      }),
    );
    // 699 directories and 1603 identities, including standalone sessions without family bindings.
    f.sessionsByDirectory.set("/project", [
      source,
      target,
      third,
      ...Array.from(
        { length: 97 },
        (_, index) => `00000000-0000-4000-8001-${String(index).padStart(12, "0")}`,
      ),
    ]);
    for (let index = 0; index < 697; index++) {
      const cwd = `/other/worktree-${index}`;
      f.worktreeRecords.push({
        worktreePath: cwd,
        projectPath: "/other",
        branch: `agent/${index}`,
        baseBranch: "main",
        createdAt: "2026-01-01",
      });
      f.sessionsByDirectory.set(
        cwd,
        Array.from(
          { length: index < 109 ? 3 : 2 },
          (_, n) => `00000000-0000-4000-8002-${String(index * 3 + n).padStart(12, "0")}`,
        ),
      );
    }
    const family = Context.get(f.context, SessionFamilyStorage);
    let familyReads = 0;
    const before = {
      locate: f.listReads.locate,
      records: f.listReads.records,
      drafts: f.listReads.drafts,
    };
    f.listReads.ids.length = 0;
    f.listReads.titles.length = 0;
    f.listReads.entries.length = 0;
    const invoke = (input: JsonObject, sender: agentControl.AgentControlCaller = caller) =>
      agentControl.invoke("sessions.list", input, sender).pipe(
        Effect.provideService(SessionFamilyStorage, {
          ...family,
          state: () => {
            familyReads++;
            return family.state();
          },
        }),
        Effect.provide(f.context),
      );
    const listing = yield* invoke({ query: "Same", offset: 3, limit: 2 });
    expect(listing).toContain("99 sessions; next=5");
    expect(f.listReads.ids).toHaveLength(699);
    expect(new Set(f.listReads.ids).size).toBe(699);
    expect(f.listReads.titles).toEqual(f.sessionsByDirectory.get("/project"));
    expect(f.listReads.entries).toEqual([]);
    expect(f.listReads.locate - before.locate).toBe(0);
    expect(f.listReads.records - before.records).toBe(1);
    expect(f.listReads.drafts - before.drafts).toBe(1);
    expect(f.listReads.resolutions).toEqual(["/project"]);
    expect(familyReads).toBe(1);
    expect(f.inspections).toHaveLength(2);
    // No retained roster: removing a transcript is visible on the very next invocation.
    f.sessionsByDirectory.set("/project", [source]);
    expect(yield* invoke({ query: "Same" })).toBe("0 sessions");
    expect(familyReads).toBe(2);
    expect(f.inspections).toHaveLength(2);
    f.listReads.titles.length = 0;
    const narrowedGlobal = yield* invoke(
      { projectPath: "/other", query: "Same", limit: 1 },
      {
        kind: "cake-chat",
        sessionId: CAKE_CHAT_SESSION_ID,
        title: "Cake Chat",
      },
    );
    expect(narrowedGlobal).toContain("1503 sessions; next=1");
    expect(f.listReads.titles).toHaveLength(1503);
    expect(f.listReads.titles).not.toContain(source);
    expect(familyReads).toBe(3);
    expect(f.inspections).toHaveLength(3);
    expect(f.runtimeCreates).toEqual([source]);
  }),
);

it.effect(
  "lists archived history after checkout retirement and omits colliding standalone identities",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const archived = "00000000-0000-4000-8000-0000deadbeef";
      f.archivedEntries.set(archived, {
        version: 2,
        sessionId: archived,
        projectPath: "/project",
        projectName: "Project",
        workingDirectory: "/deleted-checkout",
        activeRoot: "/cake/sessions",
        resolvedRoot: "/cake/resolved",
        createdAt: "2026-01-01",
        modifiedAt: "2026-03-01",
      });
      // Missing historical transcripts keep their identity/title fallback, as exact lookup does.
      expect(yield* f.direct("sessions.list", { status: "resolved" })).toContain(
        `deadbeef resolved resolved - ? ? ? ? | ${archived}`,
      );
      f.worktreeRecords.push({
        worktreePath: "/collision",
        projectPath: "/project",
        branch: "agent/collision",
        baseBranch: "main",
        createdAt: "2026-01-01",
      });
      f.sessionsByDirectory.set("/collision", [third]);
      const result = yield* f.direct("sessions.list", { query: "Same" });
      expect(result).toContain("1 sessions");
      expect(result).toContain("00000022");
      expect(result).not.toContain("00000033");
      f.unavailable.add(archived);
      expect(yield* f.direct("sessions.list", { status: "resolved" })).toBe("0 sessions");
    }),
);

it.effect("uses family-root resolution in a listing snapshot", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* Context.get(f.context, SessionFamilyStorage).addChild({
      familyId: "listing-family",
      parentSessionId: target,
      parentWorkingDirectory: "/project",
      childSessionId: third,
      childWorkingDirectory: "/retired-worktree",
      requestId: "child-request",
      projectPath: "/project",
      createdAt: "2026-01-01",
    });
    f.sessionsByDirectory.set("/project", [source, target]);
    f.sessionsByDirectory.set("/retired-worktree", [third]);
    expect(yield* f.direct("sessions.list", { status: "resolved" })).toBe("0 sessions");
    f.resolve();
    // Storage can migrate a resolved root back into place after the ID discovery pass.
    f.sessionsByDirectory.set("/project", [source]);
    const archive = Context.get(f.context, SessionArchiveStorage);
    const result = yield* agentControl.invoke("sessions.list", { status: "resolved" }, caller).pipe(
      Effect.provideService(SessionArchiveStorage, {
        ...archive,
        resolvedIds: (at) => {
          f.sessionsByDirectory.set("/project", [source, target]);
          return archive.resolvedIds(at);
        },
      }),
      Effect.provide(f.context),
    );
    expect(result).toContain("2 sessions");
    expect(result).toContain("00000022 resolved");
    expect(result).toContain("00000033 resolved");
    expect(f.listReads.locate).toBe(0);
  }),
);

it.effect("paginates a minimal session roster and filters before selecting a page", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    for (let index = 0; index < 61; index++)
      f.drafts.push({
        sessionId: `00000000-0000-4000-8000-${String(index + 100).padStart(12, "0")}`,
        projectPath: "/project",
        workingDirectory: "/project",
        title: `Paging ${index}`,
        text: "This request must not appear in a roster.",
        attachments: [],
        labelIds: [],
        resolved: false,
        createdAt: "2026-02-01",
        modifiedAt: "2026-02-01",
        revision: 1,
        status: "saved",
      });
    const first = yield* f.call("sessions.list");
    assert.ok(typeof first === "string");
    expect(first).toContain("64 sessions; next=20\n");
    expect(first.split("\n")).toHaveLength(22);
    const filtered = yield* f.call("sessions.list", {
      status: "draft",
      query: "Paging 1",
      offset: 9,
      limit: 2,
      projectPath: "/project",
    });
    expect(filtered).toBe(
      "11 sessions\nid status lifecycle outcome tokens cache age ttl | title\n00000118 draft draft - ? ? ? ? | Paging 18\n00000119 draft draft - ? ? ? ? | Paging 19",
    );
    const last = yield* f.call("sessions.list", { status: "draft", limit: 50, offset: 50 });
    assert.ok(typeof last === "string");
    expect(last.split("\n")).toHaveLength(13);
    expect(last).toContain("61 sessions\n");
    expect(yield* f.call("sessions.list", { projectPath: "/absent" })).toBe("0 sessions");
    expect(yield* f.call("sessions.info", { sessionId: target })).toMatchObject({
      session: { sessionId: target, lifecycle: "active", resolved: false },
    });
    expect(yield* f.call("sessions.list", { limit: 51 }).pipe(Effect.exit)).toMatchObject({
      _tag: "Failure",
    });
  }),
);

it.effect(
  "resolved lifecycle is independent of stopped/completed execution outcomes without content inspection",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const families = Context.get(f.context, SessionFamilyStorage);
      f.resolve();
      for (const outcome of ["stopped", "completed"] as const) {
        yield* families.registerSpawn({
          sessionId: target,
          projectPath: "/project",
          workingDirectory: "/project",
          requester: { kind: "cake-chat", sessionId: CAKE_CHAT_SESSION_ID, title: "Cake Chat" },
          reportDelivered: true,
          handoffSettled: true,
          lastReport: { status: outcome, summary: "PRIVATE_REPORT", reportedAt: "2026-01-02" },
        });
        yield* families.recordLaunchReport(target, {
          status: outcome,
          summary: "PRIVATE_REPORT",
          reportedAt: "2026-01-02",
        });
        expect(yield* f.call("sessions.info", { sessionId: target })).toMatchObject({
          session: { resolved: true, lifecycle: "resolved", outcome },
        });
        expect(f.inspections).toEqual([]);
        expect(yield* f.call("sessions.list", { status: "resolved" })).toContain(
          `00000022 resolved resolved ${outcome}`,
        );
        f.inspections.length = 0;
      }
    }),
);

it.effect(
  "sessions.list keeps launch status minimal and reports available through exact inspection",
  () =>
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
      expect(yield* f.call("sessions.list", { launchedByCakeChat: true })).toBe(
        "2 sessions\nid status lifecycle outcome tokens cache age ttl | title\n00000022 failed active failed ? ? ? ? | Same title\n00000033 done active completed ? ? ? ? | Same title",
      );
      expect(yield* f.call("sessions.info", { sessionId: target })).toMatchObject({
        session: {
          outcome: "failed",
          lifecycle: "active",
          resolved: false,
        },
      });
      expect(
        yield* f.call("sessions.list", { launchedByCakeChat: true, attentionOnly: true }),
      ).toBe(
        "1 sessions\nid status lifecycle outcome tokens cache age ttl | title\n00000022 failed active failed ? ? ? ? | Same title",
      );
      for (const status of ["interrupted", "stopped"] as const) {
        yield* families.recordLaunchReport(target, {
          status,
          summary: status,
          reportedAt: "2026-01-03",
        });
        expect(yield* f.call("sessions.list", { launchedByCakeChat: true })).toContain(
          `00000022 ${status} active ${status} ? ? ? ? | Same title`,
        );
        expect(
          yield* f.call("sessions.list", { launchedByCakeChat: true, attentionOnly: true }),
        ).toBe(
          status === "interrupted"
            ? "1 sessions\nid status lifecycle outcome tokens cache age ttl | title\n00000022 interrupted active interrupted ? ? ? ? | Same title"
            : "0 sessions",
        );
      }
      f.pauseMessage();
      yield* f.call("sessions.send", { sessionId: third, text: "Run" });
      yield* Queue.take(f.prompts);
      expect(yield* f.call("sessions.list", { launchedByCakeChat: true })).toContain(
        "00000033 running active completed ? ? ? ? | Same title",
      );
      yield* Deferred.succeed(f.messageRelease, undefined);
    }),
);

const workflowCaller = {
  kind: "cake-chat" as const,
  sessionId: CAKE_CHAT_SESSION_ID,
  title: "Cake Chat",
};
const workflowLaunch = (sessionId: string, title = "Task session") => ({
  sessionId,
  title,
  projectPath: "/project",
  workingDirectory: "/project",
  requester: { kind: "cake-chat" as const, sessionId: CAKE_CHAT_SESSION_ID, title: "Cake Chat" },
  reportDelivered: true,
  handoffSettled: true,
  launchedAt: "2026-01-01",
});

it.effect(
  "workflow roster preserves task-input names, deduplicates results and never loads content or wakes",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const storage = Context.get(f.context, SessionFamilyStorage);
      f.protectedSessions.add(target);
      f.protectedSessions.add(third);
      yield* storage.registerSpawn(workflowLaunch(target, "Task session"));
      yield* storage.registerSpawn(workflowLaunch(third, "New session"));
      yield* storage.registerSpawn(workflowLaunch(source, "Retained launch label"));
      yield* storage.registerSpawn(
        workflowLaunch("00000000-0000-4000-8000-000000000088", "Untitled"),
      );
      yield* Context.get(f.context, ApplicationState).transact((state) =>
        Effect.succeed({
          ...state,
          projects: state.projects.map((project) => ({
            ...project,
            todos: {
              items: [
                {
                  id: "00000000-0000-4000-8000-000000000099",
                  title: "Repair launch roster",
                  description: "A durable task label.",
                  status: "",
                  state: "open" as const,
                  revision: 0,
                  associations: [
                    { kind: "session" as const, sessionId: target, title: "Task session" },
                  ],
                },
              ],
              selectedId: null,
              sequence: 0,
              deliveryToken: null,
              pending: [],
            },
          })),
        }),
      );
      for (const [id, reportedAt, title] of [
        ["old", "2026-01-01", "Old result"],
        ["new", "2026-01-02", "Inspect auth routing"],
      ] as const)
        yield* storage.recordCompletion({
          id,
          reportedAt,
          title,
          sessionId: third,
          coordinatorSessionId: CAKE_CHAT_SESSION_ID,
          summary: "Investigation finished",
          resultMessageRef: messageReference(third, "result"),
          kind: "investigation",
          state: "pending",
          decisions: ["review", "next-step"],
        });
      const before = yield* storage.state();
      const invoke = yield* batchRegistry(f);
      const response = yield* invoke("sessions.list", { projection: "workflow", limit: 50 });
      const text = response.text;
      expect(text).toContain("4 launches");
      expect(text).toContain("Retained launch label");
      expect(text).toContain("Unnamed task (title unknown)");
      expect(text).toContain("Repair launch roster");
      expect(text).toContain("Inspect auth routing");
      expect(text).toContain(messageReference(third, "result"));
      expect(text).toContain(`cake://session/${target}`);
      expect(text).toContain("readiness unknown");
      expect(yield* storage.state()).toEqual(before);
      expect(f.inspections).toEqual([]);
      expect(f.queries).toEqual([]);
      expect(f.listReads.titles).toEqual([]);
      expect(f.listReads.ids).toEqual([]);
      expect(f.runtimeCreates).toEqual([source]);
      expect(f.grants).toEqual([]);
      expect(yield* Queue.size(f.prompts)).toBe(0);
    }),
);

it.effect(
  "workflow roster separates execution done, lifecycle resolution, and handled review decisions",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const storage = Context.get(f.context, SessionFamilyStorage);
      for (const id of [source, target, third])
        yield* storage.registerSpawn({
          ...workflowLaunch(
            id,
            id === source
              ? "Execution only"
              : id === target
                ? "Resolved task"
                : "Explicit ready result",
          ),
          lastReport: { status: "completed", summary: "Work finished", reportedAt: "2026-01-02" },
        });
      yield* storage.recordCompletion({
        id: "ready",
        sessionId: third,
        coordinatorSessionId: CAKE_CHAT_SESSION_ID,
        title: "Explicit ready result",
        summary: "Tests passed; review requested",
        reportedAt: "2026-01-02",
        kind: "ready",
        state: "handled",
        decisions: ["review", "merge", "resolve"],
      });
      f.resolve();
      const current = yield* f.direct("sessions.list", { projection: "workflow" }, workflowCaller);
      assert.equal(typeof current, "string");
      expect(current).toContain(
        `working\tExecution only\tcake://session/${source}\topen\tcompleted`,
      );
      expect(current).toContain(
        `ready-for-review/merge\tExplicit ready result\tcake://session/${third}\topen\tcompleted`,
      );
      expect(current).toContain("\thandled\tnone\tunknown\treview result; verify merge");
      expect(current).not.toContain("Resolved task");
      const history = yield* f.direct(
        "sessions.list",
        { projection: "workflow", includeResolved: true },
        workflowCaller,
      );
      expect(history).toContain(
        `resolved\tResolved task\tcake://session/${target}\tresolved\tcompleted`,
      );
      expect(history).toContain("3 launches");
      expect(
        yield* f.direct(
          "sessions.list",
          { projection: "workflow", status: "resolved" },
          workflowCaller,
        ),
      ).toContain("1 launches");
      expect(
        yield* f.direct(
          "sessions.list",
          { projection: "workflow", status: "done" },
          workflowCaller,
        ),
      ).toContain("2 launches");
    }),
);

it.effect(
  "workflow roster reports stopped and blocked reasons without treating completion as readiness",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const storage = Context.get(f.context, SessionFamilyStorage);
      for (const [id, status, summary] of [
        [target, "blocked", "Need repository credentials"],
        [third, "stopped", "Stopped by user"],
        [source, "failed", "Typecheck failed"],
      ] as const)
        yield* storage.registerSpawn({
          ...workflowLaunch(id, status),
          lastReport: { status, summary, reportedAt: "2026-01-02" },
        });
      const result = yield* f.direct("sessions.list", { projection: "workflow" }, workflowCaller);
      expect(result).toContain("blocked/stopped=3");
      expect(result).toContain("Need repository credentials");
      expect(result).toContain("Stopped by user");
      expect(result).toContain("Typecheck failed");
      expect(result).toContain("\tunknown\tinspect blocker/stop");
      expect(result).toContain("ready-for-review/merge=0");
    }),
);

it.effect(
  "workflow roster exposes live pending user input before running and removes the wait on cancellation",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* Context.get(f.context, SessionFamilyStorage).registerSpawn(
        workflowLaunch(source, "Choose deployment"),
      );
      f.active.add(source);
      yield* f.requests.bind({ _tag: "ProjectSession", sessionId: source }, 11);
      const uiEvents = yield* Queue.unbounded<void>();
      const uiReady = yield* Deferred.make<void>();
      yield* Context.get(f.context, ClientEvents)
        .artifacts(11)
        .pipe(
          Stream.runForEach((event) =>
            event.type === "renderer-events-ready"
              ? Deferred.succeed(uiReady, undefined)
              : event.type === "ui-request"
                ? Queue.offer(uiEvents, undefined)
                : Effect.void,
          ),
          Effect.forkScoped,
        );
      yield* Deferred.await(uiReady);
      const request = yield* f.requests
        .requestUi(source, {
          kind: "text",
          title: "Which region?",
          message: "Do not expose this full input body",
        })
        .pipe(Effect.forkChild);
      yield* Queue.take(uiEvents);
      const waiting = yield* f.direct("sessions.list", { projection: "workflow" }, workflowCaller);
      expect(waiting).toContain(
        `waiting-for-input\tChoose deployment\tcake://session/${source}\topen\twaiting\tWhich region?`,
      );
      expect(waiting).toContain("answer input");
      expect(waiting).not.toContain("Do not expose");
      yield* Fiber.interrupt(request);
      const running = yield* f.direct("sessions.list", { projection: "workflow" }, workflowCaller);
      expect(running).toContain(
        `working\tChoose deployment\tcake://session/${source}\topen\trunning`,
      );
      expect(f.inspections).toEqual([]);
      expect(f.runtimeCreates).toEqual([source]);
    }),
);

it.effect(
  "workflow roster preserves unknown lifecycle on index failure and exposes recovery blockers",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* Context.get(f.context, SessionFamilyStorage).registerSpawn(
        workflowLaunch(target, "Recover interrupted work"),
      );
      const archive = Context.get(f.context, SessionArchiveStorage);
      const runtimes = Context.get(f.context, CakeSessionRuntimes);
      const result = yield* agentControl
        .invoke("sessions.list", { projection: "workflow" }, workflowCaller)
        .pipe(
          Effect.provideService(SessionArchiveStorage, {
            ...archive,
            recordedResolvedIds: () =>
              Effect.fail(
                new SessionArchiveStorageError({
                  operation: "recordedResolvedIds",
                  sessionId: "",
                  message: "Index unavailable",
                }),
              ),
          }),
          Effect.provideService(CakeSessionRuntimes, {
            ...runtimes,
            currentStatus: () =>
              Effect.succeed({
                streaming: false,
                pending: false,
                persisted: true,
                recoveryIssue: "Unfinished tool requires user review",
              }),
          }),
          Effect.provide(f.context),
        );
      expect(result).toContain(
        `blocked/stopped\tRecover interrupted work\tcake://session/${target}\tunknown\tblocked\tUnfinished tool requires user review`,
      );
      expect(result).toContain("\tunknown\tinspect blocker/stop");
      expect(f.inspections).toEqual([]);
      expect(f.runtimeCreates).toEqual([source]);
    }),
);

it.effect(
  "workflow roster uses recorded landing state and never suggests merging already-landed work",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const storage = Context.get(f.context, SessionFamilyStorage);
      yield* storage.registerSpawn({ ...workflowLaunch(target), workingDirectory: "/managed" });
      f.worktreeRecords.push({
        projectPath: "/project",
        worktreePath: "/managed",
        branch: "agent/launch-roster",
        baseBranch: "main",
        createdAt: "2026-01-01",
        state: "resolved",
        resolvedFrom: "landed",
        landedSourceCommit: "abc123",
        baseCommit: "base123",
      });
      const result = yield* f.direct("sessions.list", { projection: "workflow" }, workflowCaller);
      expect(result).toContain("Worktree: launch-roster");
      expect(result).toContain("landed-source=abc123; head/dirty=unknown");
      expect(result).toContain("already-landed\treview/resolve; already landed");
      expect(result).toContain("\topen\tunknown");
      expect(f.listReads.titles).toEqual([]);
    }),
);

it.effect(
  "workflow roster scopes exact invoking-chat launches before filtering and bounded pagination",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const storage = Context.get(f.context, SessionFamilyStorage);
      const projectChat = { ...workflowCaller, sessionId: projectChatSessionId("/project") };
      for (let i = 0; i < 55; i++)
        yield* storage.registerSpawn({
          ...workflowLaunch(
            `00000000-0000-4000-8000-${String(i + 1000).padStart(12, "0")}`,
            `Task ${i}`,
          ),
          requester: { kind: "cake-chat", sessionId: projectChat.sessionId, title: "Project Chat" },
        });
      yield* storage.registerSpawn(workflowLaunch(target, "Global chat task"));
      yield* storage.registerSpawn({
        ...workflowLaunch(third, "Foreign project launch"),
        projectPath: "/other",
        requester: { kind: "cake-chat", sessionId: projectChat.sessionId, title: "Project Chat" },
      });
      const first = yield* f.direct(
        "sessions.list",
        { projection: "workflow", limit: 50 },
        projectChat,
      );
      expect(first).toContain("55 launches; next=50");
      expect(first).not.toContain("Global chat task");
      expect(first).not.toContain("Foreign project launch");
      const second = yield* f.direct(
        "sessions.list",
        { projection: "workflow", limit: 50, offset: 50 },
        projectChat,
      );
      expect(second).toContain("55 launches |");
      assert.ok(typeof second === "string");
      expect(second.split("\n").filter((line) => line.startsWith("working\t"))).toHaveLength(5);
      expect(
        yield* f.direct(
          "sessions.list",
          { projection: "workflow", query: "Task 54", limit: 1 },
          projectChat,
        ),
      ).toContain("1 launches |");
      expect(
        yield* f.direct(
          "sessions.list",
          { projection: "workflow", projectPath: "/other" },
          projectChat,
        ),
      ).toContain("0 launches");
      expect(
        yield* f.direct("sessions.list", { projection: "workflow" }, workflowCaller),
      ).toContain("1 launches");
      expect(yield* f.direct("sessions.list", { projection: "workflow" })).toMatchObject({
        ok: false,
      });
      expect(
        yield* f
          .direct("sessions.list", { projection: "workflow", limit: 51 }, projectChat)
          .pipe(Effect.exit),
      ).toMatchObject({ _tag: "Failure" });
      expect(f.listReads.ids).toEqual([]);
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
          resultDelivery: "notification",
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
          resultDelivery: "notification",
          maxMessages: 5,
          sender: { sessionId: CAKE_CHAT_SESSION_ID, kind: "cake-chat" },
        });
      expect(envelopes[0]?.threadId).not.toBe(envelopes[1]?.threadId);
      expect(envelopes[0]?.messageId).not.toBe(envelopes[1]?.messageId);
      expect(result.text).not.toContain("Shared instructions");
      yield* invoke("sessions.send", {
        sessionId: target,
        text: "Single follow-up",
        resultDelivery: "ignore",
      });
      const single = parseCrossSessionMessage((yield* Queue.take(f.prompts)).text)?.metadata;
      expect(single).toMatchObject({ expectsResponse: false });
      expect(single).toHaveProperty("resultDelivery", "ignore");
      expect(
        (yield* invoke("sessions.send-batch", {
          sessionIds: [target],
          text: "FYI",
          resultDelivery: "ignore",
        })).structuredContent,
      ).toMatchObject({
        result: { expectsResponse: false, resultDelivery: "ignore" },
      });
      yield* Queue.take(f.prompts);
      expect(
        JSON.parse(
          (yield* invoke("sessions.send", {
            sessionId: third,
            text: "Ping",
            resultDelivery: "reply",
          })).text,
        ),
      ).toMatchObject({
        expectsResponse: true,
        resultDelivery: "reply",
      });
      expect(parseCrossSessionMessage((yield* Queue.take(f.prompts)).text)?.metadata).toMatchObject(
        {
          expectsResponse: true,
          resultDelivery: "reply",
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
        resultDelivery: "ignore",
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
      ok: true,
      session: {
        sessionId: target,
        title: "Task session",
        deepLink: `cake://session/${target}`,
        resolved: false,
        lifecycle: "active",
      },
    });
    expect(f.inspections).toEqual([]);
    expect(yield* call("sessions.history", { sessionId: target })).toMatchObject({
      ok: false,
      error: expect.stringContaining("task inputs"),
    });
    const receipt = yield* call("sessions.send", {
      sessionId: target,
      text: "Status?",
      resultDelivery: "notification",
    });
    expect(receipt).toMatchObject({
      ok: true,
      resultDelivery: "notification",
      expectsResponse: true,
    });
    expect(receipt).not.toHaveProperty("targetTitle");
    expect(parseCrossSessionMessage((yield* Queue.take(f.prompts)).text)?.metadata).toMatchObject({
      sender: { kind: "cake-chat", sessionId: CAKE_CHAT_SESSION_ID },
      resultDelivery: "notification",
      expectsResponse: true,
    });
    expect(
      yield* call("sessions.send", { sessionId: target, text: "Quiet", resultDelivery: "ignore" }),
    ).toMatchObject({ ok: true, resultDelivery: "ignore", expectsResponse: false });
    expect(parseCrossSessionMessage((yield* Queue.take(f.prompts)).text)?.metadata).toMatchObject({
      expectsResponse: false,
    });
    expect(f.requestCalls).toEqual([]);
  }),
);
