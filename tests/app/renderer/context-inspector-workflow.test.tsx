/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { StoreProvider } from "r-state-tree/react";
import { projectChatSessionId } from "../../../src/domain/cake-chats/cakeChatLocations";
import { CakeChatPaneHeader } from "../../../src/renderer/components/cake-chat-pane-header";
import { CAKE_CHAT_SESSION_ID } from "../../../src/contracts/cake-chats/cake-chat-identity";
import type { ContextInspection } from "../../../src/contracts/conversations/context-inspection";
import type { JsonValue } from "../../../src/contracts/serialization/json-contract";
import { ContextInspector } from "../../../src/renderer/components/context-inspector";
import type { Client } from "../../../src/renderer/client/Client";
import { toJsonValue } from "../../../src/utils/to-json-value";
import { createRendererStoreFixture } from "./renderer-store-fixture";
import { projectRecord } from "./fixtures/catalog-fixtures";

afterEach(cleanup);

it("does not acquire an unsent chat and reads its Pi context once materialized", async () => {
  const inspect = vi
    .fn<Client["sessionChats"]["inspect"]>()
    .mockResolvedValue(toJsonValue(context));
  using fixture = createRendererStoreFixture({ client: { sessionChats: { inspect } } });
  const pending = fixture.root.cakeChatCollectionStore.pendingSessions;
  pending.create(CAKE_CHAT_SESSION_ID);
  const store =
    fixture.root.cakeChatCollectionStore.registry.load(CAKE_CHAT_SESSION_ID)
      .conversationSessionStore.contextInspectorStore;
  const user = userEvent.setup();
  const view = render(<ContextInspector store={store} />);
  try {
    await user.click(screen.getByRole("button", { name: "Browse context" }));
    await screen.findByText("No assembled context yet.");
    expect(inspect).not.toHaveBeenCalled();
    pending.markMaterialized(CAKE_CHAT_SESSION_ID);
    await user.click(screen.getByRole("button", { name: "Refresh context" }));
    await screen.findByRole("button", { name: "The current compressed summary" });
    expect(inspect).toHaveBeenCalledExactlyOnceWith(
      { sessionId: CAKE_CHAT_SESSION_ID, kind: "context-outline" },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  } finally {
    view.unmount();
  }
});

it("distinguishes loading, failed reads and true emptiness, then refreshes real context", async () => {
  const pending = Promise.withResolvers<JsonValue>();
  const inspect = vi
    .fn<Client["sessionChats"]["inspect"]>()
    .mockReturnValueOnce(pending.promise)
    .mockResolvedValueOnce({ sources: [] })
    .mockResolvedValue(toJsonValue(context));
  using fixture = createRendererStoreFixture({ client: { sessionChats: { inspect } } });
  const store =
    fixture.root.cakeChatCollectionStore.registry.load(CAKE_CHAT_SESSION_ID)
      .conversationSessionStore.contextInspectorStore;
  const user = userEvent.setup();
  const view = render(<ContextInspector store={store} />);
  try {
    await user.click(screen.getByRole("button", { name: "Browse context" }));
    expect(screen.getByRole("status", { name: "Loading context" })).toBeTruthy();
    expect(screen.queryByText("No assembled context yet.")).toBeNull();
    await act(async () => pending.reject(new Error("Pi context read failed")));
    expect((await screen.findByRole("alert")).textContent).toContain("Pi context read failed");
    expect(screen.queryByText("No assembled context yet.")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByText("No assembled context yet.");
    await user.click(screen.getByRole("button", { name: "Refresh context" }));
    await screen.findByRole("button", { name: "The current compressed summary" });
  } finally {
    view.unmount();
  }
});

it("routes selection changes to the new conversation and ignores the previous late response", async () => {
  const pending = Promise.withResolvers<JsonValue>();
  const nextId = projectChatSessionId("/project");
  const inspect = vi.fn<Client["sessionChats"]["inspect"]>(async ({ sessionId }) =>
    sessionId === CAKE_CHAT_SESSION_ID ? pending.promise : toJsonValue(context),
  );
  using fixture = createRendererStoreFixture({
    projects: [projectRecord({ path: "/project" })],
    client: { sessionChats: { inspect } },
  });
  const global =
    fixture.root.cakeChatCollectionStore.registry.load(CAKE_CHAT_SESSION_ID)
      .conversationSessionStore.contextInspectorStore;
  const project =
    fixture.root.cakeChatCollectionStore.registry.load(nextId).conversationSessionStore
      .contextInspectorStore;
  const user = userEvent.setup();
  const view = render(<ContextInspector store={global} />);
  try {
    await user.click(screen.getByRole("button", { name: "Browse context" }));
    view.rerender(<ContextInspector store={project} />);
    expect(inspect.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    await user.click(screen.getByRole("button", { name: "Browse context" }));
    await screen.findByRole("button", { name: "The current compressed summary" });
    expect(inspect.mock.calls[1]?.[0]).toEqual({ sessionId: nextId, kind: "context-outline" });
    await act(async () => pending.resolve({ sources: [] }));
    expect(screen.getByRole("button", { name: "The current compressed summary" })).toBeTruthy();
    expect(screen.queryByText("No assembled context yet.")).toBeNull();
  } finally {
    view.unmount();
  }
});

const context: ContextInspection = {
  sources: [
    { id: "system", title: "System prompt", text: "Literal **instructions** and <tags>." },
    {
      id: "instructions",
      title: "AGENTS.md",
      source: "/project/AGENTS.md",
      text: "Included file contents",
    },
    { id: "tools", title: "Tools", text: "Tool declarations" },
    {
      id: "memory",
      title: "Memory",
      children: [
        {
          id: "memory-0",
          title: "The current compressed summary",
          kind: "summary",
          summaryDepth: 3,
          detail: { memoryId: 0, memoryCount: 4 },
        },
      ],
    },
  ],
};
const older: ContextInspection = {
  sources: [
    {
      id: "earlier-a",
      title: "Earlier summary A",
      kind: "summary",
      summaryDepth: 2,
      detail: { memoryId: 0, memoryCount: 2 },
    },
    {
      id: "earlier-b",
      title: "Earlier summary B",
      kind: "summary",
      summaryDepth: 2,
      detail: { memoryId: 2, memoryCount: 2 },
    },
  ],
};
const baseline: ContextInspection = {
  sources: [
    {
      id: "leaf-a",
      title: "Summary of one original",
      kind: "summary",
      summaryDepth: 1,
      detail: { memoryId: 0, memoryCount: 1 },
    },
    {
      id: "leaf-b",
      title: "Another original summary",
      kind: "summary",
      summaryDepth: 1,
      detail: { memoryId: 1, memoryCount: 1 },
    },
  ],
};
const originals: ContextInspection = {
  sources: [
    { id: "original-1", title: "You", text: "Keep it quiet and simple.", kind: "original" },
    {
      id: "original-2",
      title: "Assistant",
      text: "I will use disclosure triangles.",
      kind: "original",
    },
  ],
};

it.each(["project-chat", "global"])(
  "browses %s sources and nested memory depths as literal, read-only detail",
  async (scope) => {
    const currentDetail = { memoryId: 0, memoryCount: 4 };
    const inspect = vi.fn<Client["sessionChats"]["inspect"]>(async (input) => {
      if (input.kind === "context-outline") return toJsonValue(context);
      if (input.kind === "memory-detail")
        return toJsonValue(
          input.memoryCount === 4 ? older : input.memoryCount === 2 ? baseline : originals,
        );
      throw new Error("The context reader must not run agent commands");
    });
    using fixture = createRendererStoreFixture({
      projects: [projectRecord({ path: "/project" })],
      client: { sessionChats: { inspect } },
    });
    const sessionId = scope === "global" ? CAKE_CHAT_SESSION_ID : projectChatSessionId("/project");
    const owner = fixture.root.cakeChatCollectionStore.registry.load(sessionId);
    const store = owner.conversationSessionStore.contextInspectorStore;
    const pane = {
      kind: "pane" as const,
      paneId: "context-pane",
      history: [sessionId],
      historyCursor: 0,
    };
    const user = userEvent.setup();
    const view = render(
      <StoreProvider store={fixture.root}>
        <CakeChatPaneHeader pane={pane} session={owner} />
      </StoreProvider>,
    );
    try {
      await user.click(screen.getByRole("button", { name: "Browse context" }));
      await screen.findByRole("button", { name: "The current compressed summary" });
      expect(screen.getByText("Compacted · depth 3")).toBeTruthy();
      expect(inspect).toHaveBeenCalledTimes(1);
      expect(inspect.mock.calls[0]?.[0]).toEqual({ sessionId, kind: "context-outline" });
      await user.click(screen.getByRole("button", { name: "System prompt" }));
      expect(screen.getByText("Literal **instructions** and <tags>.").textContent).toBe(
        "Literal **instructions** and <tags>.",
      );
      expect(document.querySelector("strong")).toBeNull();
      await user.click(screen.getByRole("button", { name: "AGENTS.md" }));
      expect(screen.getByText("Included file contents")).toBeTruthy();
      expect(inspect).toHaveBeenCalledTimes(1);
      await user.click(screen.getByRole("button", { name: "The current compressed summary" }));
      await screen.findByRole("button", { name: "Earlier summary A" });
      expect(screen.getByText("Earlier detail · not in the prompt")).toBeTruthy();
      expect(screen.getAllByText("Compacted · depth 2")).toHaveLength(2);
      await user.click(screen.getByRole("button", { name: "Earlier summary A" }));
      await screen.findByRole("button", { name: "Summary of one original" });
      expect(screen.getAllByText("Compacted · depth 1")).toHaveLength(2);
      await user.click(screen.getByRole("button", { name: "Summary of one original" }));
      await screen.findByText("Keep it quiet and simple.");
      expect(screen.getAllByText("Original · depth 0")).toHaveLength(2);
      expect(screen.getByText("I will use disclosure triangles.")).toBeTruthy();
      expect(inspect.mock.calls.map(([input]) => input.kind)).toEqual([
        "context-outline",
        "memory-detail",
        "memory-detail",
        "memory-detail",
      ]);
      expect(inspect.mock.calls[1]?.[0]).toEqual({
        sessionId,
        kind: "memory-detail",
        ...currentDetail,
      });
      const earlierDetail = { memoryId: 0, memoryCount: 2 };
      expect(inspect.mock.calls[2]?.[0]).toEqual({
        sessionId,
        kind: "memory-detail",
        ...earlierDetail,
      });
      await user.click(screen.getByRole("button", { name: "The current compressed summary" }));
      await user.click(screen.getByRole("button", { name: "The current compressed summary" }));
      expect(inspect.mock.calls[3]?.[0]).toEqual({
        sessionId,
        kind: "memory-detail",
        memoryId: 0,
        memoryCount: 1,
      });
      expect(inspect).toHaveBeenCalledTimes(4);
      await user.click(screen.getByRole("button", { name: "Close context" }));
      expect(store.sources).toEqual([]);
      expect(store.details).toEqual({});
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Browse context" }));
    } finally {
      view.unmount();
    }
  },
);

it("offers retry for failed history without losing the current summary", async () => {
  let failed = false;
  const inspect = vi.fn<Client["sessionChats"]["inspect"]>(async (input) => {
    if (input.kind === "context-outline") return toJsonValue(context);
    if (!failed) {
      failed = true;
      throw new Error("Earlier detail unavailable");
    }
    return toJsonValue(originals);
  });
  using fixture = createRendererStoreFixture({ client: { sessionChats: { inspect } } });
  const store =
    fixture.root.cakeChatCollectionStore.registry.load(CAKE_CHAT_SESSION_ID)
      .conversationSessionStore.contextInspectorStore;
  const user = userEvent.setup();
  const view = render(<ContextInspector store={store} />);
  try {
    await user.click(screen.getByRole("button", { name: "Browse context" }));
    await user.click(await screen.findByRole("button", { name: "The current compressed summary" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Earlier detail unavailable");
    expect(
      screen
        .getByRole("button", { name: "The current compressed summary" })
        .getAttribute("aria-expanded"),
    ).toBe("true");
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByText("Keep it quiet and simple.");
    expect(screen.queryByRole("alert")).toBeNull();
  } finally {
    view.unmount();
  }
});

it("aborts a closed reader, ignores its late result, and refreshes from the current scope on reopen", async () => {
  let release: (value: JsonValue) => void = () => {
    throw new Error("No pending read");
  };
  const inspect = vi
    .fn<Client["sessionChats"]["inspect"]>()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    )
    .mockResolvedValue(toJsonValue(context));
  using fixture = createRendererStoreFixture({ client: { sessionChats: { inspect } } });
  const store =
    fixture.root.cakeChatCollectionStore.registry.load(CAKE_CHAT_SESSION_ID)
      .conversationSessionStore.contextInspectorStore;
  const user = userEvent.setup();
  const view = render(<ContextInspector store={store} />);
  try {
    await user.click(screen.getByRole("button", { name: "Browse context" }));
    fireEvent.keyDown(screen.getByRole("dialog", { name: "Context" }), { key: "Escape" });
    expect(inspect.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    await act(async () => {
      release(toJsonValue(context));
    });
    expect(store.sources).toEqual([]);
    await user.click(screen.getByRole("button", { name: "Browse context" }));
    await screen.findByRole("button", { name: "System prompt" });
    await user.click(screen.getByRole("button", { name: "Refresh context" }));
    await waitFor(() => expect(inspect).toHaveBeenCalledTimes(3));
    await screen.findByRole("button", { name: "System prompt" });
  } finally {
    view.unmount();
  }
});
