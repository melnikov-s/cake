/** @vitest-environment jsdom */
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Effect, Queue, Stream } from "effect";
import { StoreProvider } from "r-state-tree/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationUpdate } from "../../../src/contracts/conversations/conversation-data";
import { projectPreviewSnapshot } from "../../../src/domain/conversations/conversations";
import { App } from "../../../src/renderer/components/app";
import { observeModels } from "../../../src/renderer/observers";
import { configurationModel, configurationSnapshot } from "./chat-configuration-workflow-fixture";
import { projectRecord, sessionSummary } from "./fixtures/catalog-fixtures";
import { observerClient, observerRuntime } from "./observers/observer-test-runtime";
import { createRendererStoreFixture } from "./renderer-store-fixture";

beforeEach(() => {
  vi.stubGlobal("PointerEvent", MouseEvent);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Object.defineProperty(SVGElement.prototype, "getBBox", {
    configurable: true,
    value: () => ({ x: 0, y: 0, width: 24, height: 24 }),
  });
});
afterEach(() => {
  cleanup();
  Reflect.deleteProperty(SVGElement.prototype, "getBBox");
  vi.unstubAllGlobals();
});

function renderHydration() {
  const ids = [
    "first",
    "second",
    "unconfigured",
    ...Array.from({ length: 6 }, (_, i) => `idle-${i}`),
  ];
  const queues = new Map(
    ids.map((id) => [id, Effect.runSync(Queue.unbounded<ConversationUpdate>())]),
  );
  const fixture = createRendererStoreFixture({
    projects: [projectRecord({ path: "/project", name: "Project" })],
    sessions: ids.map((sessionId) =>
      sessionSummary({ sessionId, projectPath: "/project", title: `Task ${sessionId}` }),
    ),
    client: {
      projectSessions: { open: async () => {} },
      workspaces: { loadStagedSlashCommands: async () => [] },
    },
  });
  const runtime = observerRuntime(
    observerClient({
      projects: { observeCatalog: () => Stream.never },
      projectSessions: { observeCatalog: () => Stream.never },
      cakeChats: { observeCatalog: () => Stream.never },
      managedWorktrees: {
        observeCatalog: () => Stream.never,
        observeOperations: () => Stream.never,
      },
      conversations: { observe: ({ sessionId }) => Stream.fromQueue(queues.get(sessionId)!) },
      discussionSessions: { observeCatalog: () => Stream.never },
      subagents: { observe: () => Stream.never },
      workflows: { observe: () => Stream.never },
      scheduledMessages: { observe: () => Stream.never },
    }),
  );
  const { root, models } = fixture;
  root.sessionRegistry.load("first", "/project");
  root.navigationStore.selectProjectSession("first");
  root.projectWorkbenchStore.showLoadedSession("first");
  const stop = observeModels(runtime, models, root);
  const view = render(
    <StoreProvider store={root}>
      <App />
    </StoreProvider>,
  );
  return {
    user: userEvent.setup(),
    async publish(update: ConversationUpdate) {
      const snapshot =
        update._tag !== "Event"
          ? update.snapshot
          : update.event._tag === "SnapshotUpdated"
            ? update.event.snapshot
            : undefined;
      if (!snapshot) throw new Error("Expected hydration snapshot");
      const sessionId = snapshot.sessionId;
      await act(async () => {
        Queue.offerUnsafe(queues.get(sessionId)!, update);
        await Effect.runPromise(Queue.take(runtime.consumed));
      });
    },
    [Symbol.dispose]() {
      view.unmount();
      stop();
      fixture[Symbol.dispose]();
    },
  };
}

const live = (sessionId: string, name: string, id = name): ConversationUpdate => ({
  _tag: "Snapshot",
  revision: 2,
  snapshot: configurationSnapshot(sessionId, [configurationModel({ id, name })]),
});
const preview = (sessionId: string, modelId?: string): ConversationUpdate => ({
  _tag: "Preview",
  revision: 1,
  snapshot: projectPreviewSnapshot({
    sessionId,
    sessionFile: `/project/${sessionId}.jsonl`,
    parts: [],
    ...(modelId ? { currentModel: { provider: "openai", modelId } } : {}),
  }),
});

describe("session model hydration", () => {
  it("shows the persisted model before delayed runtime hydration, then honors changes and clearing", async () => {
    using fixture = renderHydration();
    await fixture.publish(preview("first", "saved-model"));
    expect(screen.getByRole("button", { name: "Model configuration" }).textContent).toContain(
      "saved-model",
    );
    expect(screen.getByRole("button", { name: "Model configuration" }).textContent).not.toContain(
      "Choose model",
    );
    await fixture.publish(live("first", "Saved Model", "saved-model"));
    expect(screen.getByRole("button", { name: "Model configuration" }).textContent).toContain(
      "Saved Model",
    );
    await fixture.publish({
      _tag: "Event",
      revision: 3,
      event: {
        _tag: "SnapshotUpdated",
        snapshot: configurationSnapshot("first", [
          configurationModel({ id: "changed", name: "Changed Model" }),
        ]),
      },
    });
    expect(screen.getByRole("button", { name: "Model configuration" }).textContent).toContain(
      "Changed Model",
    );
    await fixture.publish({
      _tag: "Snapshot",
      revision: 3,
      snapshot: configurationSnapshot("first", []),
    });
    expect(screen.getByRole("button", { name: "Model configuration" }).textContent).toContain(
      "Choose model",
    );
  });

  it("remembers the correct session through observation eviction and reopen without leaking another session's model", async () => {
    using fixture = renderHydration();
    await fixture.publish(live("first", "First Model", "first-model"));
    await fixture.user.click(screen.getByRole("button", { name: /^Task second / }));
    await fixture.publish(preview("second", "second-model"));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Model configuration" }).textContent).toContain(
        "second-model",
      ),
    );
    await fixture.publish(live("second", "Second Model"));
    expect(screen.getByRole("button", { name: "Model configuration" }).textContent).toContain(
      "Second Model",
    );
    // Exceed the real idle observation budget so first's projection is unloaded.
    for (let i = 0; i < 6; i++) {
      await fixture.user.click(
        screen.getByRole("button", { name: new RegExp(`^Task idle-${i} `) }),
      );
      await fixture.publish(preview(`idle-${i}`));
    }
    await fixture.user.click(screen.getByRole("button", { name: /^Task first / }));
    // Navigation admits the destination on history, while live hydration stays blocked.
    await fixture.publish(preview("first"));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Model configuration" }).textContent).toContain(
        "First Model",
      ),
    );
    await fixture.publish(preview("first", "first-model"));
    expect(screen.getByRole("button", { name: "Model configuration" }).textContent).toContain(
      "First Model",
    );
    // A different persisted identity must supersede the retained selection too.
    await fixture.publish(preview("first", "disk-changed-model"));
    expect(screen.getByRole("button", { name: "Model configuration" }).textContent).toContain(
      "disk-changed-model",
    );
    await fixture.publish(live("first", "New First Model"));
    expect(screen.getByRole("button", { name: "Model configuration" }).textContent).toContain(
      "New First Model",
    );
    await fixture.user.click(screen.getByRole("button", { name: /^Task unconfigured / }));
    await fixture.publish(preview("unconfigured"));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Model configuration" }).textContent).toContain(
        "Choose model",
      ),
    );
  });
});
