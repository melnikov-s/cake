import { cakeChatControlTools } from "../../../src/contracts/application/window-control-definitions";
import { makeSubagentStorageTestLayer } from "../helpers/subagentStorageFixture";
import { it } from "@effect/vitest";
import { WorkflowTestLive } from "../helpers/workflowFixture";
import { Effect, Layer, Stream } from "effect";
import { describe, expect } from "vitest";
import * as chatLocations from "../../../src/domain/cake-chats/cakeChatLocations";
import * as metadata from "../../../src/domain/cake-chats/cakeChatMetadata";
import { configureCakeSessionRuntime } from "../../../src/layers/CakeOperations";
import { acquireOptions } from "../../../src/domain/cake-chats/cakeChatRuntime";
import { CAKE_CHAT_SESSION_ID } from "../../../src/contracts/cake-chats/cake-chat-identity";
import {
  PROJECT_TODO_CLOSING_RULE,
  PROJECT_TODO_CREATION_RULE,
} from "../../../src/contracts/projects/project-todos";
import { defaultCakeChatPreferences } from "../../../src/contracts/cake-chats/cake-chat-preferences";
import { defaultProjectSettings } from "../../../src/contracts/application/application-data";
import { defaultApplicationState } from "../../../src/contracts/application/application-data";
import { ApplicationState } from "../../../src/services/storage/ApplicationState";
import { CakeSessionRuntimes } from "../../../src/services/pi/CakeSessionRuntimes";
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

function fixture() {
  let state = defaultApplicationState();
  const completions: string[] = [];
  const completionTimeouts: Array<number | undefined> = [];
  const removed: string[] = [];
  const changes: SessionCatalogChange[] = [];
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
      catalogEntry: (_, id) =>
        Effect.succeed(id === CAKE_CHAT_SESSION_ID ? summary(id) : undefined),
      catalog: () =>
        Stream.fromIterable(
          [summary(CAKE_CHAT_SESSION_ID)].filter((item) => !removed.includes(item.id)),
        ),
    }),
    Layer.mock(SessionArchiveStorage, {}),
    SubagentCoordinatorLive.pipe(Layer.provide(makeSubagentStorageTestLayer())),
    Layer.mock(SubagentEnvironment, {}),
  );
  return {
    layer,
    completions,
    completionTimeouts,
    removed,
    state: () => state,
    changes,
    setState: (next: typeof state) => {
      state = next;
    },
  };
}

describe("permanent Cake Chat", () => {
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
          "todos.list",
          "todos.read",
          "todos.create",
          "todos.update",
          "todos.update-many",
        ]);
        const prompt = () => configured.cakeChatSystemPrompt?.() ?? "";
        expect(prompt()).toContain("/zombies chat only.");
        expect(prompt()).not.toContain("/other chat only.");
        expect(prompt()).not.toContain("Coding only.");
        expect(commands).toContain("html.present");
        expect(options.runtime.persistArtifact).toBeDefined();
        expect(options.runtime.allowedCakeOperations).toContain("settings.project-chat.update");
        expect(options.runtime.allowedCakeOperations).not.toContain("settings.cake-chat.update");
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
        expect(globalPrompt()).toContain(globalTodo.id);
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

  it.effect("uses the registered project's trust for permanent-chat resource discovery", () => {
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
      const options = () =>
        acquireOptions({
          configuration: projectConfiguration,
          target: { sessionId, tools: [] },
          newSession: false,
        });
      const untrusted = yield* options();
      expect(untrusted.runtime.cwd).toBe(project.path);
      expect(untrusted.runtime.trusted).toBe(false);
      f.setState({ ...f.state(), trustedProjectPaths: [project.path] });
      const trusted = yield* options();
      expect(trusted.runtime.trusted).toBe(true);
      expect(trusted.runtime.tools).toEqual(untrusted.runtime.tools);
      expect(trusted.runtime.allowedCakeOperations).toEqual(
        expect.arrayContaining([
          "artifacts.link",
          "artifacts.present",
          "artifacts.state.read",
          "artifacts.selection.capture",
          "artifacts.source",
        ]),
      );
      expect(trusted.runtime.allowedCakeOperations).not.toContain("artifacts.resolve-reference");
      expect(trusted.runtime.allowedCakeOperations).not.toContain("artifacts.preview");
      expect(trusted.runtime.resolveArtifact).toBeTypeOf("function");
      expect(trusted.runtime.linkArtifact).toBeTypeOf("function");
      expect(trusted.runtime.readArtifactState).toBeTypeOf("function");
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
