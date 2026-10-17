/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { CAKE_CHAT_SESSION_ID } from "../../../src/contracts/cake-chats/cake-chat-identity";
import type { ContextInspection } from "../../../src/contracts/conversations/context-inspection";
import type { JsonValue } from "../../../src/contracts/serialization/json-contract";
import { ContextInspector } from "../../../src/renderer/components/context-inspector";
import type { Client } from "../../../src/renderer/client/Client";
import { toJsonValue } from "../../../src/utils/to-json-value";
import { createRendererStoreFixture } from "./renderer-store-fixture";
import { projectRecord, sessionSummary } from "./fixtures/catalog-fixtures";

afterEach(cleanup);

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
      detail: { memoryId: 0, memoryCount: 2 },
    },
    {
      id: "earlier-b",
      title: "Earlier summary B",
      kind: "summary",
      detail: { memoryId: 2, memoryCount: 2 },
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

it.each(["project", "global"])(
  "browses %s sources and nested memory as literal, read-only detail",
  async (scope) => {
    const currentDetail =
      scope === "project" ? { entryId: "project-summary" } : { memoryId: 0, memoryCount: 4 };
    const sourceContext: ContextInspection =
      scope === "project"
        ? {
            sources: [
              ...context.sources.filter((node) => node.id !== "memory"),
              {
                id: "memory",
                title: "Memory",
                children: [
                  {
                    id: "memory-0",
                    title: "The current compressed summary",
                    kind: "summary",
                    detail: currentDetail,
                  },
                ],
              },
            ],
          }
        : context;
    const previous: ContextInspection =
      scope === "project"
        ? {
            sources: older.sources.map((node) => ({ ...node, detail: { entryId: node.id } })),
          }
        : older;
    const inspect = vi.fn<Client["sessionChats"]["inspect"]>(async (input) => {
      if (input.kind === "context-outline") return toJsonValue(sourceContext);
      if (input.kind === "memory-detail")
        return toJsonValue(
          input.memoryCount === 4 || input.entryId === "project-summary" ? previous : originals,
        );
      throw new Error("The context reader must not run agent commands");
    });
    using fixture = createRendererStoreFixture({
      projects: [projectRecord({ path: "/project" })],
      sessions: [sessionSummary({ sessionId: "project-session", projectPath: "/project" })],
      client: { sessionChats: { inspect } },
    });
    const sessionId = scope === "global" ? CAKE_CHAT_SESSION_ID : "project-session";
    const owner =
      scope === "global"
        ? fixture.root.cakeChatCollectionStore.registry.load(sessionId)
        : fixture.root.sessionRegistry.load(sessionId, "/project");
    const store = owner.conversationSessionStore.contextInspectorStore;
    const user = userEvent.setup();
    const view = render(<ContextInspector store={store} />);
    try {
      await user.click(screen.getByRole("button", { name: "Browse context" }));
      await screen.findByRole("button", { name: "The current compressed summary" });
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
      await user.click(screen.getByRole("button", { name: "Earlier summary A" }));
      await screen.findByText("Keep it quiet and simple.");
      expect(screen.getByText("I will use disclosure triangles.")).toBeTruthy();
      expect(inspect.mock.calls.map(([input]) => input.kind)).toEqual([
        "context-outline",
        "memory-detail",
        "memory-detail",
      ]);
      expect(inspect.mock.calls[1]?.[0]).toEqual({
        sessionId,
        kind: "memory-detail",
        ...currentDetail,
      });
      const earlierDetail =
        scope === "project" ? { entryId: "earlier-a" } : { memoryId: 0, memoryCount: 2 };
      expect(inspect.mock.calls[2]?.[0]).toEqual({
        sessionId,
        kind: "memory-detail",
        ...earlierDetail,
      });
      await user.click(screen.getByRole("button", { name: "The current compressed summary" }));
      await user.click(screen.getByRole("button", { name: "The current compressed summary" }));
      expect(inspect).toHaveBeenCalledTimes(3);
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
