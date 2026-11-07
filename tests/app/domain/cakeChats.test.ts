import { cakeChatControlTools } from "../../../src/contracts/application/window-control-definitions";
import { makeSubagentStorageTestLayer } from "../helpers/subagentStorageFixture";
import { it } from "@effect/vitest";
import { WorkflowTestLive } from "../helpers/workflowFixture";
import { Context, Deferred, Effect, Fiber, Layer, Queue, Stream } from "effect";
import { describe, expect, vi } from "vitest";
import { VsCodeServer } from "../../../src/services/vscode/VsCodeServer";
import { CakeChatDurable } from "../../../src/services/pi-durable/CakeChatDurable";
import { SavedDraftStorage } from "../../../src/services/storage/SavedDraftStorage";
import { CakeOperationRegistry } from "../../../src/services/pi/runtime/cake-operation-registry";
import * as chatLocations from "../../../src/domain/cake-chats/cakeChatLocations";
import * as metadata from "../../../src/domain/cake-chats/cakeChatMetadata";
import { configureCakeSessionRuntime } from "../../../src/layers/CakeOperations";
import { acquireOptions } from "../../../src/domain/cake-chats/cakeChatRuntime";
import {
  acquireTarget,
  observeConversation,
} from "../../../src/domain/cake-chats/cakeChatOperations";
import { SESSION_ASSISTANT_ID } from "../../../src/contracts/cake-chats/cake-chat-identity";
import { defaultAssistantPreferences } from "../../../src/contracts/cake-chats/cake-chat-preferences";
import {
  CAKE_CHAT_SESSION_ID,
  cakeChatSideChatSessionId,
} from "../../../src/contracts/cake-chats/cake-chat-identity";
import {
  PROJECT_TODO_CLOSING_RULE,
  PROJECT_TODO_CREATION_RULE,
} from "../../../src/contracts/projects/project-todos";
import { defaultCakeChatPreferences } from "../../../src/contracts/cake-chats/cake-chat-preferences";
import { defaultProjectSettings } from "../../../src/contracts/application/application-data";
import { defaultApplicationState } from "../../../src/contracts/application/application-data";
import { ApplicationState } from "../../../src/services/storage/ApplicationState";
import {
  CakeSessionRuntimes,
  PiSessionError,
  makeCakeSessionRuntimesLayer,
} from "../../../src/services/pi/CakeSessionRuntimes";
import { CakeChatConfiguration } from "../../../src/services/pi-durable/CakeChatConfiguration";
import { sessionChatHandlers } from "../../../src/ipc/server/SessionChatHandlers";
import { RendererConnection } from "../../../src/ipc/protocol/RendererConnectionMiddleware";
import { AttachmentUploads } from "../../../src/services/filesystem/AttachmentUploads";
import { familyStorageHarness } from "../helpers/familyStorageHarness";
import {
  fakeRuntime,
  makeRuntimeRecoveryStorageTestLayer,
  snapshot as runtimeSnapshot,
} from "../helpers/piRuntimeFixture";
import { PiModels } from "../../../src/services/pi/PiModels";
import { RendererRequestCoordinator } from "../../../src/services/renderer-requests/RendererRequestCoordinator";
import {
  SessionCatalogChanges,
  type SessionCatalogChange,
} from "../../../src/services/session-catalogs/SessionCatalogChanges";
import { SessionArchiveStorage } from "../../../src/services/storage/SessionArchiveStorage";
import { SubagentCoordinatorLive } from "../../../src/services/subagents/SubagentCoordinator";
import { SubagentEnvironment } from "../../../src/services/subagents/SubagentEnvironment";

import { makeHeadlessProjectSessionRuntimeMechanismTestLayer } from "./projectSessionRuntimeTestLayer";
import { ManagedWorktrees } from "../../../src/services/worktrees/ManagedWorktrees";
import { SessionFamilyStorage } from "../../../src/services/storage/SessionFamilyStorage";

const location = {
  workingDirectory: "/home/user",
  sessionDirectory: "/cake/global",
};
const configuration = { location, agentDirectory: "/cake/pi" };

function fixture(runtimeOverrides: Partial<CakeSessionRuntimes["Service"]> = {}) {
  let state = defaultApplicationState();
  const completions: string[] = [];
  const completionTimeouts: Array<number | undefined> = [];
  const removed: string[] = [];
  const changes: SessionCatalogChange[] = [];
  const catalogReads: string[] = [];
  const summary = (id: string) => ({
    id,
    path: `/cake/global/${id}.jsonl`,
    cwd: "/home/user",
    created: "2026-01-01T00:00:00Z",
    modified: "2026-01-01T00:00:00Z",
    messageCount: 1,
    title: "Chat",
    resolved: false,
    firstMessage: "Hello",
  });
  const layer = Layer.mergeAll(
    WorkflowTestLive,
    makeHeadlessProjectSessionRuntimeMechanismTestLayer(),
    Layer.mock(ManagedWorktrees, {}),
    Layer.mock(SessionFamilyStorage, {}),
    Layer.mock(ApplicationState, {
      snapshot: () => state,
      current: () => Effect.succeed(state),
      changes: () => Stream.empty,
      transact: (transition) =>
        transition(state).pipe(
          Effect.tap((next) =>
            Effect.sync(() => {
              state = next;
            }),
          ),
        ),
    }),
    Layer.mock(PiModels, {
      complete: (input) =>
        Effect.sync(() => {
          completions.push(input.selection.modelId);
          completionTimeouts.push(input.timeoutMs);
          return "summary";
        }),
    }),
    Layer.mock(RendererRequestCoordinator, { releaseSession: () => Effect.void }),
    Layer.mock(SessionCatalogChanges, {
      publish: (change) =>
        Effect.sync(() => {
          changes.push(change);
        }),
      initialThenChanges: (initial) => initial.pipe(Stream.concat(Stream.fromIterable(changes))),
    }),
    Layer.mock(CakeSessionRuntimes, {
      currentStatus: () => Effect.succeed(undefined),
      catalogEntry: (_, id) =>
        Effect.sync(() => {
          catalogReads.push(id);
          return id === CAKE_CHAT_SESSION_ID ? summary(id) : undefined;
        }),
      catalog: () =>
        Stream.fromIterable(
          [summary(CAKE_CHAT_SESSION_ID)].filter((item) => !removed.includes(item.id)),
        ),
      ...runtimeOverrides,
    }),
    Layer.mock(SessionArchiveStorage, {}),
    SubagentCoordinatorLive.pipe(Layer.provide(makeSubagentStorageTestLayer())),
    Layer.mock(SubagentEnvironment, {}),
  );
  return {
    layer,
    completions,
    completionTimeouts,
    catalogReads,
    removed,
    state: () => state,
    changes,
    setState: (next: typeof state) => {
      state = next;
    },
  };
}

describe("permanent Cake Chat", () => {
  it.effect.each(["cold", "warming", "assembled"] as const)(
    "submits the first Project Chat input through renderer binding while %s",
    (phase) => {
      const f = fixture();
      const projectPath = "/cold-project";
      const sessionId = chatLocations.projectChatSessionId(projectPath);
      f.setState({
        ...defaultApplicationState(),
        projects: [
          {
            path: projectPath,
            name: "Cold project",
            addedAt: "2026-01-01T00:00:00.000Z",
            lastOpenedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      });
      const bindings: Array<{ sessionId: string; connectionId: number; profile: string }> = [];
      const deliveries: string[] = [];
      return Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const releaseFactory = yield* Deferred.make<void>();
        const delivered = yield* Deferred.make<void>();
        const acquisitionAttempts = yield* Queue.unbounded<string>();
        let constructions = 0;
        const context = yield* Layer.build(
          makeCakeSessionRuntimesLayer({
            sessionIds: () => Stream.empty,
            catalog: () => Stream.empty,
            catalogEntry: () => Effect.succeed(undefined),
            inspect: () => Effect.succeed(undefined),
            changelog: () => Effect.succeed(""),
            createRuntime: (runtimeOptions) =>
              Effect.gen(function* () {
                constructions += 1;
                yield* Deferred.succeed(started, undefined);
                if (phase === "warming") yield* Deferred.await(releaseFactory);
                const runtime = fakeRuntime(runtimeOptions, () => undefined);
                return {
                  ...runtime,
                  sessionId,
                  snapshot: async () => ({
                    ...runtimeSnapshot,
                    workspacePath: projectPath,
                    sessionId,
                  }),
                  prompt: async (text) => {
                    deliveries.push(text);
                    await Effect.runPromise(Deferred.succeed(delivered, undefined));
                  },
                };
              }),
          }).pipe(Layer.provide(makeRuntimeRecoveryStorageTestLayer())),
        );
        const runtimes = Context.get(context, CakeSessionRuntimes);
        const observed = CakeSessionRuntimes.of({
          ...runtimes,
          acquireSession: (id) =>
            Queue.offer(acquisitionAttempts, id).pipe(Effect.andThen(runtimes.acquireSession(id))),
        });
        yield* Effect.gen(function* () {
          const warming =
            phase !== "cold"
              ? yield* acquireTarget(
                  { sessionId, tools: cakeChatControlTools() },
                  false,
                  configuration,
                ).pipe(Effect.forkScoped)
              : undefined;
          if (warming) yield* Deferred.await(started);
          if (warming && phase === "assembled") yield* Fiber.join(warming);
          const input = {
            sessionId,
            text: "Read retained handoff",
            attachments: [],
            renderUserMessageAsMarkdown: false,
          };
          const submission = yield* sessionChatHandlers["sessionChats.prompt"](input).pipe(
            Effect.forkScoped,
          );
          if (warming && phase === "warming") {
            expect(yield* Queue.take(acquisitionAttempts)).toBe(sessionId);
            yield* Deferred.succeed(releaseFactory, undefined);
            yield* Fiber.join(warming);
          }
          const turnId = yield* Fiber.join(submission);
          yield* Deferred.await(delivered);
          expect(turnId).toMatch(/^[a-f0-9-]{36}$/);
          expect(constructions).toBe(1);
          expect(bindings).toEqual([{ sessionId, connectionId: 41, profile: "CakeChatSession" }]);
          expect(deliveries).toEqual(["Read retained handoff"]);
        }).pipe(Effect.provideService(CakeSessionRuntimes, observed));
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            familyStorageHarness().layer,
            Layer.succeed(CakeChatConfiguration, configuration),
            Layer.succeed(RendererConnection, { connectionId: 41, correlationId: "cold-submit" }),
            Layer.mock(AttachmentUploads, {
              admit: (_owner, attachments) => Effect.succeed(attachments),
            }),
            Layer.mock(RendererRequestCoordinator, {
              bind: (target, connectionId) =>
                Effect.sync(() => {
                  bindings.push({
                    sessionId: target.sessionId,
                    connectionId,
                    profile: target._tag,
                  });
                }),
              releaseSession: () => Effect.void,
            }),
          ),
        ),
        Effect.provide(f.layer),
      );
    },
  );

  it.effect(
    "rejects a cold Project Chat with no registered project before binding or construction",
    () => {
      const sessionId = chatLocations.projectChatSessionId("/unregistered");
      const f = fixture({
        acquireSession: () =>
          Effect.fail(
            new PiSessionError({
              operation: "acquireSession",
              message: `Pi Session ${sessionId} has not been assembled`,
            }),
          ),
        acquire: () => Effect.die("Unregistered Project Chat must not construct a runtime"),
      });
      return sessionChatHandlers["sessionChats.prompt"]({
        sessionId,
        text: "Not admitted",
        attachments: [],
        renderUserMessageAsMarkdown: false,
      }).pipe(
        Effect.flip,
        Effect.tap((error) =>
          Effect.sync(() => {
            expect(error).toMatchObject({
              _tag: "SessionChatError",
              operation: "deliver",
              message: "Project Chat belongs to no registered project",
            });
          }),
        ),
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(CakeChatConfiguration, configuration),
            Layer.succeed(RendererConnection, { connectionId: 41, correlationId: "unknown-chat" }),
            Layer.mock(AttachmentUploads, {}),
          ),
        ),
        Effect.provide(f.layer),
      );
    },
  );

  it.effect.each([
    { kind: "global Cake Chat", sessionId: CAKE_CHAT_SESSION_ID },
    { kind: "Companion", sessionId: SESSION_ASSISTANT_ID },
    { kind: "Project Session", sessionId: "project-session" },
    { kind: "Subagent Session", sessionId: "private-worker" },
    { kind: "Discussion Session", sessionId: cakeChatSideChatSessionId(2) },
    { kind: "malformed Project Chat", sessionId: "project-chat:not-a-hash" },
  ])("does not reconstruct a cold $kind through Project Chat submission", ({ sessionId }) => {
    const message = `Pi Session ${sessionId} has not been assembled`;
    const f = fixture({
      acquireSession: () =>
        Effect.fail(new PiSessionError({ operation: "acquireSession", message })),
      acquire: () => Effect.die("Other profiles must not be reconstructed"),
    });
    return sessionChatHandlers["sessionChats.prompt"]({
      sessionId,
      text: "Not admitted",
      attachments: [],
      renderUserMessageAsMarkdown: false,
    }).pipe(
      Effect.flip,
      Effect.tap((error) =>
        Effect.sync(() => {
          expect(error).toMatchObject({ _tag: "SessionChatError", operation: "acquire", message });
        }),
      ),
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(CakeChatConfiguration, configuration),
          Layer.succeed(RendererConnection, { connectionId: 41, correlationId: "other-profile" }),
          Layer.mock(AttachmentUploads, {}),
        ),
      ),
      Effect.provide(f.layer),
    );
  });

  it.effect("looks up only the exact registered chat metadata before its first turn", () => {
    const f = fixture();
    f.setState({
      ...defaultApplicationState(),
      projects: ["/new-project", "/other-project"].map((path) => ({
        path,
        name: path.slice(1),
        addedAt: "2026-01-01T00:00:00.000Z",
        lastOpenedAt: "2026-01-01T00:00:00.000Z",
      })),
    });
    const sessionId = chatLocations.projectChatSessionId("/new-project");
    return Effect.gen(function* () {
      expect(yield* metadata.lookup(sessionId, location)).toEqual({
        sessionId,
        running: false,
        projectPath: "/new-project",
        title: "new-project",
        createdAt: "2026-01-01T00:00:00.000Z",
        modifiedAt: "2026-01-01T00:00:00.000Z",
        messageCount: 0,
        resolved: false,
        unread: false,
      });
      expect(f.catalogReads).toEqual([sessionId]);
      const error = yield* metadata
        .lookup(chatLocations.projectChatSessionId("/unregistered"), location)
        .pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "CakeChatError",
        operation: "lookup",
        message: "Cake could not find that registered chat.",
      });
      expect(f.catalogReads).toEqual([sessionId]);
    }).pipe(Effect.provide(f.layer));
  });
  it.effect(
    "publishes cold Project Chat history before acquiring any runtime, using the owning project identity",
    () => {
      const queries: unknown[] = [];
      const f = fixture({
        hasCurrent: () => Effect.succeed(false),
        catalogEntry: (query, id) =>
          Effect.succeed({
            id,
            path: `${query.sessionDirectory}/coordinator.sqlite`,
            cwd: query.workingDirectory,
            created: "2026-01-01T00:00:00Z",
            modified: "2026-01-01T00:00:00Z",
            messageCount: 1,
            title: "Project history",
            resolved: false,
            firstMessage: "Hello",
          }),
        inspect: (query) => {
          queries.push(query);
          return Effect.succeed({
            workspacePath: query.workingDirectory,
            sessionId: query.sessionId,
            sessionFile: `${query.sessionDirectory}/coordinator.sqlite`,
            parts: [
              {
                id: "history",
                kind: "text",
                role: "user",
                text: query.workingDirectory,
                status: "complete",
              },
            ],
          });
        },
        acquire: () => Effect.die("History must not wait for runtime acquisition"),
      });
      f.setState({
        ...defaultApplicationState(),
        projects: ["/alpha", "/beta"].map((path) => ({
          path,
          name: path.slice(1),
          addedAt: "2026-01-01T00:00:00Z",
          lastOpenedAt: "2026-01-01T00:00:00Z",
        })),
      });
      return Effect.gen(function* () {
        for (const path of ["/alpha", "/beta"]) {
          const sessionId = chatLocations.projectChatSessionId(path);
          const updates = yield* observeConversation({ sessionId, tools: [] }, configuration);
          const first = yield* updates.pipe(Stream.take(1), Stream.runCollect);
          expect(first).toMatchObject([
            {
              _tag: "Preview",
              snapshot: {
                sessionId,
                parts: [{ text: path }],
                sessionFile: `${chatLocations.projectLocation(location, path).sessionDirectory}/coordinator.sqlite`,
              },
            },
          ]);
        }
        expect(queries).toEqual(
          ["/alpha", "/beta"].map((path) => ({
            ...chatLocations.projectLocation(location, path),
            sessionId: chatLocations.projectChatSessionId(path),
            cakeChatSessionId: chatLocations.projectChatSessionId(path),
            direct: true,
          })),
        );
      }).pipe(Effect.provide(f.layer));
    },
  );
  it.effect.each([true, false])(
    "does not replay disk history for a live or unstarted chat (live: %s)",
    (current) => {
      const f = fixture({
        hasCurrent: () => Effect.succeed(current),
        catalogEntry: () =>
          current ? Effect.die("Live chats must not read disk history") : Effect.succeed(undefined),
        inspect: () => Effect.die("No historical preview is appropriate"),
        acquire: () =>
          Effect.fail(
            new PiSessionError({ operation: "acquire", message: "Reached live acquisition" }),
          ),
      });
      return Effect.gen(function* () {
        const stream = yield* observeConversation(
          { sessionId: CAKE_CHAT_SESSION_ID, tools: [] },
          configuration,
        );
        const error = yield* stream.pipe(Stream.runDrain, Effect.flip);
        expect(error.message).toContain("Reached live acquisition");
      }).pipe(Effect.provide(f.layer));
    },
  );

  it.effect(
    "keeps the companion projectless with independent small configurable memory and utility summaries",
    () => {
      const f = fixture();
      const utility = { provider: "p", modelId: "utility", thinkingLevel: "off" } as const;
      f.setState({
        ...defaultApplicationState(),
        utilityModel: utility,
        cakeChatPreferences: {
          ...defaultCakeChatPreferences(),
          instructions: "Shared chat only",
          summarizationModel: {
            source: "model",
            model: { provider: "p", modelId: "expensive", thinkingLevel: "off", fastMode: false },
          },
        },
      });
      return Effect.gen(function* () {
        const location = yield* chatLocations.resolve(configuration.location, SESSION_ASSISTANT_ID);
        expect(location).toEqual({
          workingDirectory: "/home/user",
          sessionDirectory: "/cake/companion",
        });
        expect(yield* chatLocations.resolve(configuration.location, SESSION_ASSISTANT_ID)).toEqual(
          location,
        );
        const options = yield* acquireOptions({
          configuration: { ...configuration, location },
          target: { sessionId: SESSION_ASSISTANT_ID, tools: cakeChatControlTools() },
          newSession: false,
        });
        expect(options.runtime.sessionId).toBe(SESSION_ASSISTANT_ID);
        expect(options.runtime.utilityModel?.()).toEqual(utility);
        const memory = options.runtime.cakeChatMemory!;
        expect(memory.preferences()).toEqual(defaultAssistantPreferences());
        expect(memory.preferences().memoryViewBytes).toBeLessThan(
          defaultCakeChatPreferences().memoryViewBytes,
        );
        expect(options.runtime.cakeChatSystemPrompt?.()).toContain("app-wide companion");
        expect(options.runtime.cakeChatSystemPrompt?.()).toContain(SESSION_ASSISTANT_ID);
        expect(options.runtime.cakeChatSystemPrompt?.()).toContain('sessionId: "parent"');
        expect(options.runtime.cakeChatSystemPrompt?.()).toContain("schedules to yourself");
        expect(options.runtime.cakeChatTodos).toBeUndefined();
        expect(options.runtime.vscodeControl).toBeDefined();
        yield* Effect.promise(() =>
          expect(
            options.runtime.vscodeControl!.runScript(
              "return null",
              null,
              new AbortController().signal,
            ),
          ).rejects.toThrow("VS Code is unavailable in this host"),
        );
        expect(memory.preferences().instructions).not.toContain("Shared chat only");
        yield* Effect.promise(() =>
          memory.summarize({
            instructions: "Summarize",
            context: "Own dialogue",
            signal: new AbortController().signal,
            caller: { provider: "p", modelId: "expensive", thinkingLevel: "off", fastMode: false },
          }),
        );
        expect(f.completions).toEqual(["utility"]);
        f.setState({
          ...f.state(),
          assistantPreferences: {
            ...defaultAssistantPreferences(),
            instructions: "Brief",
            memoryViewBytes: 5_000,
          },
        });
        expect(memory.preferences()).toMatchObject({
          instructions: "Brief",
          memoryViewBytes: 5_000,
        });
        expect(f.state().cakeChatPreferences?.instructions).toBe("Shared chat only");
      }).pipe(Effect.provide(f.layer));
    },
  );
  it.effect(
    "discovers and executes Companion VS Code controls against the current project and actual session checkout without acquiring a coding agent",
    () => {
      const f = fixture();
      const timestamp = "2026-01-01T00:00:00Z";
      f.setState({
        ...f.state(),
        projects: [
          { path: "/project", name: "Project", addedAt: timestamp, lastOpenedAt: timestamp },
        ],
      });
      let viewed: string | undefined = chatLocations.projectChatSessionId("/project");
      let visible = false;
      const request = vi.fn<RendererRequestCoordinator["Service"]["requestCakeChatControl"]>(
        (_sessionId, invocation) => {
          if (invocation.name === "vscode.enter") visible = true;
          return Effect.succeed({ ok: true });
        },
      );
      const runScript = vi.fn<VsCodeServer["Service"]["runProjectScript"]>(
        (_directory, _source, input) =>
          Effect.succeed(
            visible
              ? { status: "completed" as const, value: input }
              : { status: "mode-required" as const },
          ),
      );
      return Effect.gen(function* () {
        const options = yield* acquireOptions({
          configuration,
          target: {
            sessionId: SESSION_ASSISTANT_ID,
            tools: [
              ...cakeChatControlTools(),
              // Companion's renderer advertises these controls as well.
              ...[
                "vscode.enter",
                "vscode.open",
                "vscode.selections.add",
                "vscode.selections.set",
                "vscode.selections.list",
                "vscode.selections.remove",
                "vscode.selections.clear",
              ].map((command) => ({
                command,
                topic: "vscode",
                summary: "Renderer editor control",
                parameters: { type: "object", properties: {} },
              })),
            ],
          },
          newSession: false,
        });
        const configured = configureCakeSessionRuntime({
          ...options.runtime,
          onEvent: () => undefined,
        });
        const operations = new CakeOperationRegistry(
          configured.coordinator!.operations({
            sessionId: SESSION_ASSISTANT_ID,
            resolveModel: () => ({
              provider: "p",
              modelId: "m",
              thinkingLevel: "off",
              fastMode: false,
            }),
            setModel: async () => undefined,
            info: async () => ({}),
            usage: async () => ({}),
            contextStatus: async () => ({}),
            compact: async () => ({}),
          }),
        );
        expect(operations.help()).toContain("vscode —");
        expect(operations.topicHelp("vscode")).toContain("vscode.script.run");
        expect(operations.operationHelp("vscode.script.run")).toContain(
          "vscode, input, and require",
        );
        const context = {
          signal: new AbortController().signal,
          toolCallId: "companion-vscode",
          runtime: { sessionId: SESSION_ASSISTANT_ID },
        };
        const source =
          "await vscode.workspace.getConfiguration('editor').update('fontSize', input.size, vscode.ConfigurationTarget.Workspace); return input;";
        const script = { command: "vscode.script.run", input: { source, input: { size: 16 } } };
        const invoke = (input: Parameters<CakeOperationRegistry["invoke"]>[0]) =>
          Effect.promise(() => operations.invoke(input, context));
        expect((yield* invoke(script)).details).toMatchObject({
          result: { ok: false, error: { code: "VSCODE_MODE_REQUIRED", retryable: true } },
        });
        expect((yield* invoke({ command: "vscode.enter" })).details).toMatchObject({
          result: { entered: true },
        });
        expect(request).toHaveBeenCalledWith(
          SESSION_ASSISTANT_ID,
          { name: "vscode.enter", arguments: {} },
          context.signal,
        );
        expect((yield* invoke(script)).details).toMatchObject({
          result: { ok: true, result: { size: 16 } },
        });
        expect(runScript).toHaveBeenLastCalledWith("/project", source, { size: 16 });
        // Same Companion runtime follows a Project Session in a different checkout.
        viewed = "viewed-worker";
        yield* invoke(script);
        expect(runScript).toHaveBeenLastCalledWith("/worktree", source, { size: 16 });
        viewed = "10000000-0000-4000-8000-000000000001";
        yield* invoke(script);
        expect(runScript).toHaveBeenLastCalledWith("/draft-checkout", source, { size: 16 });
        expect(options.runtime.cwd).toBe("/home/user");
        expect(options.runtime.sessionId).toBe(SESSION_ASSISTANT_ID);
        for (const unavailable of [undefined, CAKE_CHAT_SESSION_ID, SESSION_ASSISTANT_ID]) {
          viewed = unavailable;
          yield* Effect.promise(() =>
            expect(operations.invoke(script, context)).rejects.toThrow(
              /Open a Project Chat or Project Session.*vscode.enter/,
            ),
          );
        }
        expect(runScript).toHaveBeenCalledTimes(4);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            f.layer,
            Layer.mock(CakeChatDurable, {
              assistantContextSessionId: () => Effect.succeed(viewed),
            }),
            Layer.mock(VsCodeServer, { runProjectScript: runScript, leaseFor: () => undefined }),
            Layer.mock(SavedDraftStorage, {
              list: () =>
                Effect.succeed([
                  {
                    sessionId: "10000000-0000-4000-8000-000000000001",
                    projectPath: "/project",
                    workingDirectory: "/draft-checkout",
                    title: "Draft",
                    text: "",
                    attachments: [],
                    labelIds: [],
                    resolved: false,
                    createdAt: timestamp,
                    modifiedAt: timestamp,
                    revision: 1,
                    status: "saved" as const,
                  },
                ]),
            }),
            Layer.mock(RendererRequestCoordinator, { requestCakeChatControl: request }),
            Layer.mock(SessionFamilyStorage, { familyForMember: () => Effect.succeed(undefined) }),
            Layer.mock(SessionArchiveStorage, {
              resolvedProjectEntry: () => Effect.succeed(undefined),
              locate: (id, location) =>
                Effect.succeed(
                  id === "viewed-worker" && location.cwd === "/worktree"
                    ? ("active" as const)
                    : undefined,
                ),
            }),
            Layer.mock(ManagedWorktrees, {
              records: () =>
                Effect.succeed([
                  {
                    projectPath: "/project",
                    worktreePath: "/worktree",
                    branch: "agent/viewed",
                    baseBranch: "main",
                    createdAt: timestamp,
                  },
                ]),
            }),
          ),
        ),
      );
    },
  );
  it.effect(
    "catalogs registered Project Chats without starting Harnesses and validates scope locations",
    () => {
      const f = fixture();
      f.setState({
        ...defaultApplicationState(),
        projects: ["/zombies", "/finances"].map((path) => ({
          path,
          name: path.slice(1),
          addedAt: "2026-01-01T00:00:00.000Z",
          lastOpenedAt: "2026-01-01T00:00:00.000Z",
        })),
      });
      return Effect.gen(function* () {
        const entries = yield* metadata.catalog(location);
        const zombieId = chatLocations.projectChatSessionId("/zombies");
        const financeId = chatLocations.projectChatSessionId("/finances");
        expect(zombieId).not.toBe(financeId);
        expect(entries.map((entry) => entry.sessionId)).toEqual([
          CAKE_CHAT_SESSION_ID,
          zombieId,
          financeId,
        ]);
        expect(entries[1]).toMatchObject({
          projectPath: "/zombies",
          title: "zombies",
          messageCount: 0,
        });
        const zombie = yield* chatLocations.resolve(location, zombieId);
        const finance = yield* chatLocations.resolve(location, financeId);
        expect(zombie.workingDirectory).toBe("/zombies");
        expect(zombie.sessionDirectory).not.toBe(finance.sessionDirectory);
        expect(zombie.sessionDirectory).not.toBe(location.sessionDirectory);
        expect(yield* chatLocations.resolve(location, CAKE_CHAT_SESSION_ID)).toEqual(location);
        expect(
          yield* Effect.flip(
            chatLocations.resolve(location, chatLocations.projectChatSessionId("/unregistered")),
          ),
        ).toMatchObject({
          operation: "locate",
          message: expect.stringContaining("no registered project"),
        });
        yield* metadata.setUnread(true, zombieId);
        const after = yield* metadata.catalog(location);
        expect(after.find((entry) => entry.sessionId === zombieId)?.unread).toBe(true);
        expect(after.find((entry) => entry.sessionId === CAKE_CHAT_SESSION_ID)?.unread).toBe(false);
        expect(after.find((entry) => entry.sessionId === financeId)?.unread).toBe(false);
      }).pipe(Effect.provide(f.layer));
    },
  );
  it.effect(
    "keeps live Project Chat instructions local and scopes tools to the registered project",
    () => {
      const f = fixture();
      const project = (path: string) => ({
        path,
        name: path.slice(1),
        addedAt: "2026-01-01T00:00:00.000Z",
        lastOpenedAt: "2026-01-01T00:00:00.000Z",
        settings: {
          ...defaultProjectSettings(),
          customInstructions: "Coding only.",
          projectChatInstructions: path + " chat only.",
        },
      });
      f.setState({
        ...defaultApplicationState(),
        projects: [project("/zombies"), project("/other")],
      });
      return Effect.gen(function* () {
        const sessionId = chatLocations.projectChatSessionId("/zombies");
        const options = yield* acquireOptions({
          configuration: {
            ...configuration,
            location: yield* chatLocations.resolve(location, sessionId),
          },
          target: { sessionId, tools: cakeChatControlTools() },
          newSession: false,
        });
        const configured = configureCakeSessionRuntime({
          ...options.runtime,
          onEvent: () => undefined,
        });
        const commands = configured.coordinator
          ?.operations({
            sessionId,
            resolveModel: () => ({
              provider: "p",
              modelId: "m",
              thinkingLevel: "off",
              fastMode: false,
            }),
            setModel: async () => undefined,
            info: async () => ({}),
            usage: async () => ({}),
            contextStatus: async () => ({}),
            compact: async () => ({}),
          })
          .map((definition) => definition.command);
        expect(commands?.filter((command) => command.startsWith("todos."))).toEqual([
          "todos.select",
          "todos.list",
          "todos.read",
          "todos.create",
          "todos.update",
          "todos.snooze",
          "todos.unsnooze",
          "todos.update-many",
        ]);
        const prompt = () => configured.cakeChatSystemPrompt?.() ?? "";
        expect(prompt()).toContain("/zombies chat only.");
        expect(prompt()).not.toContain("/other chat only.");
        expect(prompt()).not.toContain("Coding only.");
        expect(commands).toContain("html.present");
        expect(commands).toEqual(
          expect.arrayContaining([
            "plugins.present",
            "plugins.patch",
            "plugins.update",
            "plugins.delete",
          ]),
        );
        const pluginControl = options.runtime.sessionPluginControl;
        if (!pluginControl) throw new Error("Expected Project Chat plugin authority");
        expect(pluginControl.sessionId).toBe(sessionId);
        const registry = new CakeOperationRegistry(
          configured.coordinator!.operations({
            sessionId,
            resolveModel: () => ({
              provider: "p",
              modelId: "m",
              thinkingLevel: "off",
              fastMode: false,
            }),
            setModel: async () => undefined,
            info: async () => ({}),
            usage: async () => ({}),
            contextStatus: async () => ({}),
            compact: async () => ({}),
          }),
        );
        const pluginContext = {
          signal: new AbortController().signal,
          toolCallId: "project-plugin",
          runtime: { sessionId },
        };
        yield* Effect.promise(() =>
          registry.invoke(
            {
              command: "plugins.present",
              input: {
                plugin: {
                  id: "guide",
                  title: "Guide",
                  preset: "action-bar",
                  initialState: {
                    label: "First",
                    actions: [{ id: "next", label: "Next", message: "Next" }],
                  },
                },
              },
            },
            pluginContext,
          ),
        );
        expect(f.state().sessionPlugins).toEqual([
          expect.objectContaining({ sessionId, id: "guide" }),
        ]);
        yield* Effect.promise(() =>
          registry.invoke(
            { command: "plugins.patch", input: { id: "guide", patch: { label: "Second" } } },
            pluginContext,
          ),
        );
        expect(f.state().sessionPlugins[0]?.state).toEqual({
          label: "Second",
          actions: [{ id: "next", label: "Next", message: "Next" }],
        });
        yield* Effect.promise(() =>
          registry.invoke({ command: "plugins.delete", input: { id: "guide" } }, pluginContext),
        );
        expect(f.state().sessionPlugins).toEqual([]);
        expect(options.runtime.persistArtifact).toBeDefined();
        expect(options.runtime.allowedCakeOperations).toContain("settings.project-chat.update");
        expect(options.runtime.allowedCakeOperations).not.toContain("settings.cake-chat.update");
        // Its own Project's settings, scoped by the backend handler.
        for (const command of ["projects.settings.get", "projects.settings.update"]) {
          expect(options.runtime.allowedCakeOperations).toContain(command);
          expect(commands).toContain(command);
        }
        // Project Chats can inspect and change every user setting the Settings UI offers.
        for (const command of [
          "settings.list",
          "settings.get",
          "settings.update",
          "settings.pi.reload",
          "settings.window.update",
          "settings.speech.set-voice",
        ])
          expect(commands).toContain(command);
        expect(options.runtime.cakeChatInstructions).toBeUndefined();
        const todoControl = options.runtime.projectTodos;
        if (!todoControl) throw new Error("Expected Project Chat to-do controls");
        const todoSignal = new AbortController().signal;
        const todo = yield* Effect.promise(() =>
          todoControl.create(
            {
              title: "Project commitment",
              description: "Project commitment.",
              status: "Investigating",
            },
            todoSignal,
          ),
        );
        expect(prompt()).toContain(todo.id);
        expect(prompt()).toContain("Project commitment");
        expect((yield* Effect.promise(() => todoControl.list({}, todoSignal))).items).toHaveLength(
          1,
        );
        expect(f.state().projects[1]?.todos).toBeUndefined();
        const control = options.runtime.projectChatInstructions;
        if (!control) throw new Error("Expected Project Chat instruction authority");
        const signal = new AbortController().signal;
        const saved = yield* Effect.promise(() =>
          control.update(
            {
              projectPath: "/zombies",
              expectedInstructions: "/zombies chat only.",
              instructions: "Updated while running.",
            },
            signal,
          ),
        );
        expect(
          yield* Effect.promise(() => control.get({ projectPath: "/zombies" }, signal)),
        ).toEqual(saved);
        expect(prompt()).toContain("Updated while running.");
        expect(prompt()).not.toContain("/zombies chat only.");
        yield* Effect.tryPromise(() =>
          control.update(
            {
              projectPath: "/other",
              expectedInstructions: "/other chat only.",
              instructions: "Wrong project.",
            },
            signal,
          ),
        ).pipe(Effect.flip);
        expect(f.state().projects[1]?.settings?.projectChatInstructions).toBe("/other chat only.");
        const global = yield* acquireOptions({
          configuration,
          target: { sessionId: CAKE_CHAT_SESSION_ID, tools: [] },
          newSession: false,
        });
        // Global Cake Chat keeps its own to-do list, separate from every Project's list.
        const globalPrompt = () => global.runtime.cakeChatSystemPrompt?.() ?? "";
        expect(globalPrompt()).toContain("## Cake Chat to-dos (application context)");
        expect(globalPrompt()).toContain("separate from every Project Chat's list");
        expect(globalPrompt()).toContain(PROJECT_TODO_CREATION_RULE);
        expect(globalPrompt()).toContain(PROJECT_TODO_CLOSING_RULE);
        expect(globalPrompt()).not.toContain("Project commitment");
        expect(global.runtime.allowedCakeOperations).toContain("html.present");
        expect(global.runtime.persistArtifact).toBeDefined();
        expect(global.runtime.allowedCakeOperations).toContain("todos.update-many");
        expect(global.runtime.onCakeChatInputConsumed).toBeDefined();
        const globalTodos = global.runtime.projectTodos;
        if (!globalTodos) throw new Error("Expected global Cake Chat to-do controls");
        const globalTodo = yield* Effect.promise(() =>
          globalTodos.create(
            { title: "Global commitment", description: "Global commitment." },
            todoSignal,
          ),
        );
        for (const [control, id] of [
          [todoControl, todo.id],
          [globalTodos, globalTodo.id],
        ] as const) {
          expect(
            yield* Effect.promise(() => control.select({ selectedId: id }, todoSignal)),
          ).toEqual({ selectedId: id });
          expect(
            yield* Effect.promise(() => control.select({ selectedId: null }, todoSignal)),
          ).toEqual({ selectedId: null });
        }
        // View focus is presentation only; it never enters either chat's baseline.
        expect(prompt()).not.toContain("selectedId");
        expect(globalPrompt()).not.toContain("selectedId");
        expect(globalPrompt()).toContain(globalTodo.id);
        expect(global.runtime.cakeChatTodos?.().map((item) => item.id)).toEqual([globalTodo.id]);
        expect(options.runtime.cakeChatTodos?.().map((item) => item.id)).toEqual([todo.id]);
        const utilityModel = { provider: "p", modelId: "cheap", thinkingLevel: "off" } as const;
        f.setState({ ...f.state(), utilityModel });
        expect(global.runtime.utilityModel?.()).toEqual(utilityModel);
        expect(options.runtime.utilityModel?.()).toEqual(utilityModel);
        expect(prompt()).not.toContain("Global commitment");
        expect(f.state().cakeChatTodos?.items.map((item) => item.title)).toEqual([
          "Global commitment",
        ]);
        expect(f.state().projects[0]?.todos?.items.map((item) => item.title)).toEqual([
          "Project commitment",
        ]);
        expect(
          (yield* Effect.promise(() => globalTodos.list({}, todoSignal))).items.map(
            (item) => item.title,
          ),
        ).toEqual(["Global commitment"]);
        expect(global.runtime.additionalSystemPrompt).toBeUndefined();
        expect(global.runtime.cakeChatInstructions).toBeDefined();
      }).pipe(Effect.provide(f.layer));
    },
  );

  it.effect("runs a permanent Project Chat in its registered project", () => {
    const f = fixture();
    const project = {
      path: "/zombies",
      name: "zombies",
      addedAt: "2026-01-01T00:00:00.000Z",
      lastOpenedAt: "2026-01-01T00:00:00.000Z",
    };
    f.setState({ ...defaultApplicationState(), projects: [project] });
    return Effect.gen(function* () {
      const sessionId = chatLocations.projectChatSessionId(project.path);
      const projectConfiguration = {
        ...configuration,
        location: yield* chatLocations.resolve(location, sessionId),
      };
      const options = yield* acquireOptions({
        configuration: projectConfiguration,
        target: { sessionId, tools: [] },
        newSession: false,
      });
      expect(options.runtime.cwd).toBe(project.path);
      expect(options.runtime.allowedCakeOperations).toEqual(
        expect.arrayContaining([
          "artifacts.link",
          "artifacts.present",
          "artifacts.state.read",
          "artifacts.selection.capture",
          "artifacts.source",
          "artifacts.resolve-reference",
          "artifacts.globals",
          "artifacts.viewing",
          "artifacts.tools",
          "artifacts.call",
        ]),
      );
      expect(options.runtime.allowedCakeOperations).not.toContain("artifacts.preview");
      expect(options.runtime.resolveArtifact).toBeTypeOf("function");
      expect(options.runtime.linkArtifact).toBeTypeOf("function");
      expect(options.runtime.readArtifactState).toBeTypeOf("function");
    }).pipe(Effect.provide(f.layer));
  });

  it.effect(
    "persists manual reminders under the coordinator identity and projects them in fresh catalogs and live updates",
    () => {
      const f = fixture();
      return Effect.gen(function* () {
        yield* metadata.setUnread(true);
        expect(f.state().unreadSessionIds).toEqual([CAKE_CHAT_SESSION_ID]);
        expect(f.changes).toEqual([
          { _tag: "CakeChatSessionChanged", sessionId: CAKE_CHAT_SESSION_ID, resolved: false },
        ]);
        const catalog = yield* metadata.observeCatalog({ resolved: false }, location);
        const updates = yield* catalog.pipe(Stream.take(2), Stream.runCollect);
        expect(updates[0]).toMatchObject({
          _tag: "Snapshot",
          sessions: [{ sessionId: CAKE_CHAT_SESSION_ID, unread: true }],
        });
        expect(updates[1]).toMatchObject({
          _tag: "Snapshot",
          sessions: [{ sessionId: CAKE_CHAT_SESSION_ID, unread: true }],
        });
        yield* metadata.setUnread(false);
        expect(f.state().unreadSessionIds).toEqual([]);
        const reopened = yield* metadata.observeCatalog({ resolved: false }, location);
        expect((yield* reopened.pipe(Stream.take(1), Stream.runCollect))[0]).toMatchObject({
          _tag: "Snapshot",
          sessions: [{ unread: false }],
        });
      }).pipe(Effect.provide(f.layer));
    },
  );

  it.effect(
    "grants coordination and memory tools, with live dedicated preferences and utility fallback",
    () => {
      const f = fixture();
      return Effect.gen(function* () {
        const options = yield* acquireOptions({
          configuration,
          target: { sessionId: CAKE_CHAT_SESSION_ID, tools: [] },
          newSession: true,
        });
        expect(options.runtime.tools).toEqual(["cake", "zoom", "date", "read", "bash", "mcp"]);
        expect(options.runtime.allowedCakeOperations).toContain("sessions.create");
        expect(options.runtime.allowedCakeOperations).toContain("settings.cake-chat.get");
        expect(options.runtime.allowedCakeOperations).toContain("settings.cake-chat.update");
        expect(options.runtime.allowedCakeOperations).toContain("workflows.propose");
        expect(options.runtime.allowedCakeOperations).toContain("workflows.start");
        expect(options.runtime.allowedCakeOperations).not.toContain("sessions.create-child");
        expect(options.runtime.allowedCakeOperations).toContain("worktrees.merge");
        expect(options.runtime.allowedCakeOperations).not.toContain("worktrees.discard");
        expect(options.runtime.cakeChatWorktrees?.merge).toBeTypeOf("function");
        for (const command of [
          "projects.list",
          "projects.add",
          "projects.rename",
          "projects.remove",
          "projects.settings.get",
          "projects.settings.update",
        ])
          expect(options.runtime.allowedCakeOperations).toContain(command);
        expect(options.runtime.cakeChatProjects?.add).toBeTypeOf("function");
        expect(options.runtime.cakeChatMemory?.preferences()).toEqual(defaultCakeChatPreferences());
        f.setState({
          ...defaultApplicationState(),
          utilityModel: { provider: "p", modelId: "cheap", thinkingLevel: "off" },
        });
        const summarize = options.runtime.cakeChatMemory!.summarize;
        expect(
          yield* Effect.promise(() =>
            summarize({
              instructions: "compress",
              context: "history",
              signal: new AbortController().signal,
            }),
          ),
        ).toBe("summary");
        f.setState({
          ...defaultApplicationState(),
          cakeChatPreferences: {
            memoryViewBytes: 5_000,
            instructions: "Always create worktrees",
            summarizationModel: {
              source: "model",
              model: { provider: "p", modelId: "chosen", thinkingLevel: "off", fastMode: false },
            },
          },
        });
        yield* Effect.promise(() =>
          summarize({
            instructions: "compress",
            context: "history",
            signal: new AbortController().signal,
          }),
        );
        // Inherit summarizes with Cake Chat's current model.
        const preferences = { memoryViewBytes: 5_000, instructions: "Always create worktrees" };
        f.setState({
          ...defaultApplicationState(),
          cakeChatPreferences: { ...preferences, summarizationModel: { source: "inherit" } },
        });
        yield* Effect.promise(() =>
          summarize({
            instructions: "compress",
            context: "history",
            signal: new AbortController().signal,
            caller: { provider: "p", modelId: "chat", thinkingLevel: "high", fastMode: false },
          }),
        );
        // A missing utility model fails clearly instead of substituting another model.
        f.setState({ ...defaultApplicationState(), cakeChatPreferences: preferences });
        yield* Effect.promise(() =>
          summarize({
            instructions: "compress",
            context: "history",
            signal: new AbortController().signal,
          }).then(
            () => expect.fail("Expected summarization to require a utility model"),
            (error: unknown) => expect(String(error)).toMatch(/no utility model is configured/),
          ),
        );
        expect(f.completions).toEqual(["cheap", "chosen", "chat"]);
        expect(f.completionTimeouts).toEqual([undefined, undefined, undefined]);
        f.setState({
          ...defaultApplicationState(),
          cakeChatPreferences: {
            ...preferences,
            summarizationModel: {
              source: "model",
              model: { provider: "p", modelId: "chosen", thinkingLevel: "off", fastMode: false },
            },
          },
        });
        expect(options.runtime.cakeChatMemory?.preferences().instructions).toBe(
          "Always create worktrees",
        );
      }).pipe(Effect.provide(f.layer));
    },
  );

  it.effect(
    "wires dedicated instructions to the live application authority without desktop controls",
    () => {
      const f = fixture();
      return Effect.gen(function* () {
        const options = yield* acquireOptions({
          configuration,
          target: { sessionId: CAKE_CHAT_SESSION_ID, tools: [] },
          newSession: true,
        });
        const control = options.runtime.cakeChatInstructions;
        expect(control).toBeDefined();
        if (!control) throw new Error("Expected instruction control");
        const signal = new AbortController().signal;
        expect(yield* Effect.promise(() => control.get(signal))).toEqual({ instructions: "" });
        const saved = yield* Effect.promise(() =>
          control.update(
            { expectedInstructions: "", instructions: "User-approved guidance." },
            signal,
          ),
        );
        expect(saved).toEqual({ instructions: "User-approved guidance." });
        expect(yield* Effect.promise(() => control.get(signal))).toEqual(saved);
        // The next run's prompt reads this same live preference; no runtime reload is needed.
        expect(options.runtime.cakeChatMemory?.preferences().instructions).toBe(saved.instructions);
        expect(f.state().globalCustomInstructions).toBe("");
      }).pipe(Effect.provide(f.layer));
    },
  );

  it.effect(
    "exposes the permanent coordinator in the active catalog and has no resolved lane",
    () => {
      const f = fixture();
      return Effect.gen(function* () {
        const active = yield* metadata.observeCatalog({ resolved: false }, location);
        // Mock the authority's snapshot+subscription join, retaining the real catalog policy.
        const updates = yield* active.pipe(Stream.take(1), Stream.runCollect);
        expect(updates[0]).toMatchObject({
          _tag: "Snapshot",
          sessions: [{ sessionId: CAKE_CHAT_SESSION_ID }],
        });
        const resolved = yield* metadata.observeCatalog({ resolved: true, limit: 10 }, location);
        const resolvedUpdates = yield* resolved.pipe(Stream.take(1), Stream.runCollect);
        expect(resolvedUpdates[0]).toMatchObject({
          _tag: "Snapshot",
          sessions: [],
          hasMore: false,
        });
      }).pipe(Effect.provide(f.layer));
    },
  );
});
