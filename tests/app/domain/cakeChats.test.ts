import { it } from "@effect/vitest";
import { WorkflowTestLive } from "../helpers/workflowFixture";
import { Effect, Layer, Stream } from "effect";
import { describe, expect } from "vitest";
import * as metadata from "../../../src/domain/cake-chats/cakeChatMetadata";
import { acquireOptions } from "../../../src/domain/cake-chats/cakeChatRuntime";
import { CAKE_CHAT_SESSION_ID } from "../../../src/ipc/cake-chat-data";
import { defaultCakeChatPreferences } from "../../../src/contracts/cake-chats/cake-chat-preferences";
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
  resolvedSessionDirectory: "/cake/global-resolved",
};
const configuration = { location, agentDirectory: "/cake/pi" };

function fixture() {
  let state = defaultApplicationState();
  const completions: string[] = [];
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
      catalogEntry: (_, id) => Effect.succeed(summary(id)),
      catalog: () =>
        Stream.fromIterable(
          [summary("old-active"), summary(CAKE_CHAT_SESSION_ID)].filter(
            (item) => !removed.includes(item.id),
          ),
        ),
    }),
    Layer.mock(SessionArchiveStorage, {}),
    SubagentCoordinatorLive,
    Layer.mock(SubagentEnvironment, {}),
  );
  return {
    layer,
    completions,
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
          _tag: "Event",
          event: { _tag: "Upserted", session: { sessionId: CAKE_CHAT_SESSION_ID, unread: true } },
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
        expect(options.runtime.tools).toEqual(["cake", "zoom", "date"]);
        expect(options.runtime.allowedCakeOperations).toContain("sessions.create");
        expect(options.runtime.allowedCakeOperations).toContain("workflows.propose");
        expect(options.runtime.allowedCakeOperations).toContain("workflows.start");
        expect(options.runtime.allowedCakeOperations).not.toContain("sessions.create-child");
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
            summarizationModel: { provider: "p", modelId: "chosen", thinkingLevel: "off" },
          },
        });
        yield* Effect.promise(() =>
          summarize({
            instructions: "compress",
            context: "history",
            signal: new AbortController().signal,
          }),
        );
        expect(f.completions).toEqual(["cheap", "chosen"]);
        expect(options.runtime.cakeChatMemory?.preferences().instructions).toBe(
          "Always create worktrees",
        );
      }).pipe(Effect.provide(f.layer));
    },
  );

  it.effect(
    "exposes only the permanent coordinator in the active catalog and has no resolved lane",
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
