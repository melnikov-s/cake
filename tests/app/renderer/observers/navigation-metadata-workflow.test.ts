import { Effect, Stream } from "effect";
import { effect, observable } from "r-state-tree";
import { expect, it, vi } from "vitest";
import { CAKE_CHAT_SESSION_ID } from "../../../../src/contracts/cake-chats/cake-chat-identity";
import type { DiscussionThreadMetadata } from "../../../../src/contracts/discussion-sessions/discussion-session-data";
import {
  SubagentHandleId,
  type SubagentMetadata,
} from "../../../../src/contracts/subagents/subagent-data";
import { createModelObserver } from "../../../../src/renderer/observers/models";
import { createRendererStoreFixture } from "../renderer-store-fixture";
import { projectRecord, sessionSummary } from "../fixtures/catalog-fixtures";
import { observerClient, observerRuntime } from "./observer-test-runtime";

const timestamp = "2026-01-01T00:00:00Z";
const thread = (parentSessionId: string, sidecarSessionId: string): DiscussionThreadMetadata => ({
  id: `thread-${sidecarSessionId}`,
  workingDirectory: "/cake",
  parentSessionId,
  sidecarSessionId,
  title: `${sidecarSessionId} discussion`,
  running: false,
  status: "open",
  createdAt: timestamp,
  updatedAt: timestamp,
});
const handleId = SubagentHandleId.make("10000000-0000-4000-8000-000000000001");

it("discovers cold scoped owners and nested metadata without opening conversations, and cancels prior-scope demand", async () => {
  using fixture = createRendererStoreFixture({
    projects: [projectRecord({ path: "/cake" }), projectRecord({ path: "/other" })],
    sessions: [
      sessionSummary({ sessionId: "cold", projectPath: "/cake" }),
      sessionSummary({ sessionId: "other", projectPath: "/other" }),
    ],
  });
  const scope = observable<{ projectPath: string | undefined }>({ projectPath: "/cake" });
  const stopped: string[] = [];
  const live = <A>(id: string, value: A) =>
    Stream.succeed(value).pipe(
      Stream.concat(Stream.never),
      Stream.ensuring(
        Effect.sync(() => {
          stopped.push(id);
        }),
      ),
    );
  const discussions = vi.fn(({ parentSessionId }: { parentSessionId: string }) =>
    live(
      `discussion:${parentSessionId}`,
      parentSessionId === "cold"
        ? [thread("cold", "sidecar")]
        : parentSessionId === "sidecar"
          ? [thread("sidecar", "nested-sidecar")]
          : [],
    ),
  );
  const workers = vi.fn(({ parentSessionId }: { parentSessionId: string }) =>
    live(
      `worker:${parentSessionId}`,
      parentSessionId === "nested-sidecar"
        ? [
            {
              parentSessionId,
              handleId,
              anchorPartId: "spawn",
              task: "Nested real worker",
              status: "running",
              streaming: true,
              released: false,
              resolved: false,
            } satisfies SubagentMetadata,
          ]
        : [],
    ),
  );
  const fullConversation = vi.fn(() => Stream.never);
  const fullWorkers = vi.fn(() => Stream.never);
  const fullDiscussions = vi.fn(() => Stream.never);
  const globalDiscussions = vi.fn(() => live("global-discussions", []));
  const observer = createModelObserver(
    observerRuntime(
      observerClient({
        projects: { observeCatalog: () => Stream.never },
        managedWorktrees: {
          observeCatalog: () => Stream.never,
          observeOperations: () => Stream.never,
        },
        automations: { observe: () => Stream.never },
        cakeChats: {
          observeCatalog: () => Stream.never,
          observeSideChatMetadata: globalDiscussions,
        },
        conversations: { observe: fullConversation },
        subagents: { observeMetadata: workers, observe: fullWorkers },
        discussionSessions: {
          observeMetadata: discussions,
          observeCatalog: fullDiscussions,
          observe: fullConversation,
        },
      }),
    ),
  );
  observer.observe({
    projection: fixture.models,
    navigationTargets: () =>
      fixture.root.conversationNavigatorStore.metadataTargets(scope.projectPath),
    loadedProjectSessions: () => [],
    loadedCakeChatIds: () => [],
    projectSessionCatalogQueries: () => [],
    cakeChatCatalogQueries: () => [],
    projectSessionTargets: () => [],
    cakeChatTargets: () => [],
  });
  try {
    await vi.waitFor(() =>
      expect(
        [...fixture.root.conversationNavigatorStore.tree("/cake").byKey.values()].map(
          (node) => node.title,
        ),
      ).toContain("Nested real worker"),
    );
    expect(fixture.models.projectConversations).toHaveLength(0);
    expect(fixture.models.discussionConversations).toHaveLength(0);
    expect(fixture.root.sessionRegistry.targets).toHaveLength(0);
    expect(fullConversation).not.toHaveBeenCalled();
    expect(fullWorkers).not.toHaveBeenCalled();
    expect(fullDiscussions).not.toHaveBeenCalled();
    expect(discussions.mock.calls.map(([input]) => input.parentSessionId)).toEqual(
      expect.arrayContaining(["cold", "sidecar", "nested-sidecar"]),
    );
    expect(discussions.mock.calls.map(([input]) => input.parentSessionId)).not.toContain("other");
    scope.projectPath = "/other";
    await vi.waitFor(() =>
      expect(discussions.mock.calls.map(([input]) => input.parentSessionId)).toContain("other"),
    );
    await vi.waitFor(() =>
      expect(stopped).toEqual(
        expect.arrayContaining([
          "discussion:cold",
          "worker:cold",
          "discussion:sidecar",
          "worker:sidecar",
          "discussion:nested-sidecar",
          "worker:nested-sidecar",
        ]),
      ),
    );
    expect(fixture.models.projectConversations).toHaveLength(0);
    scope.projectPath = undefined;
    await vi.waitFor(() =>
      expect(globalDiscussions).toHaveBeenCalledWith({ sessionId: CAKE_CHAT_SESSION_ID }),
    );
    await vi.waitFor(() => expect(stopped).toContain("discussion:other"));
    expect(fixture.root.conversationNavigatorStore.tree(undefined).total).toBe(1);
  } finally {
    observer.stop();
  }
});

it("keeps metadata demand stable across activity snapshots and updates it when nested ownership changes", () => {
  using fixture = createRendererStoreFixture({
    projects: [projectRecord({ path: "/cake" })],
    sessions: [sessionSummary({ sessionId: "owner", projectPath: "/cake" })],
  });
  const catalog = fixture.models.discussionCatalog("owner");
  catalog.metadataLoaded = true;
  catalog.metadata.push(thread("owner", "sidecar"));
  const demanded = vi.fn();
  const stop = effect(() =>
    demanded(fixture.root.conversationNavigatorStore.metadataTargets("/cake")),
  );
  try {
    expect(demanded).toHaveBeenCalledTimes(1);
    catalog.metadata.splice(0, 1, { ...thread("owner", "sidecar"), running: true });
    expect(demanded).toHaveBeenCalledTimes(1);
    const nested = fixture.models.discussionCatalog("sidecar");
    nested.metadataLoaded = true;
    nested.metadata.push(thread("sidecar", "nested"));
    expect(
      demanded.mock.lastCall?.[0].map((target: { sessionId: string }) => target.sessionId),
    ).toContain("nested");
    const count = demanded.mock.calls.length;
    nested.metadata.splice(0, 1, { ...thread("sidecar", "nested"), title: "Updated title" });
    expect(demanded).toHaveBeenCalledTimes(count);
    catalog.metadata.splice(0, 1);
    expect(
      demanded.mock.lastCall?.[0].map((target: { sessionId: string }) => target.sessionId),
    ).not.toContain("nested");
  } finally {
    stop();
  }
});
