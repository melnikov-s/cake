/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ConversationSnapshot } from "../../../src/contracts/conversations/session-contract";
import { projectChatSessionId } from "../../../src/domain/cake-chats/cakeChatLocations";
import { projectRecord } from "./fixtures/catalog-fixtures";
import { CAKE_CHAT_SESSION_ID } from "../../../src/contracts/cake-chats/cake-chat-identity";
import type { CakeChatContextStatus } from "../../../src/contracts/cake-chats/context-policy";
import { Chat } from "../../../src/renderer/components/chat";
import { applyConversationSnapshot } from "../../../src/renderer/reducers/ConversationReducer";
import { createRendererStoreFixture } from "./renderer-store-fixture";

const at = Date.now();
const status: CakeChatContextStatus = {
  systemTokens: 5_000,
  memoryTokens: 10_000,
  messageTokens: 30_000,
  totalTokens: 45_000,
  configuredLimitTokens: 300_000,
  modelLimitTokens: 400_000,
  limitTokens: 300_000,
  cache: {
    provider: "unknown-provider",
    modelId: "example",
    requestedAt: at,
    inputTokens: 40_000,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  },
};

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function fixture(
  initial = status,
  scope: "global" | "project-chat" = "global",
  parts: ConversationSnapshot["parts"] = [],
) {
  const inspect = vi.fn(async () => ({
    sources: [
      {
        id: "memory",
        title: "Memory",
        children: [
          {
            id: "summary",
            title: "Worktree preference",
            kind: "summary",
            summaryDepth: 1,
            detail: { memoryId: 0, memoryCount: 1 },
          },
        ],
      },
    ],
  }));
  const compact = vi.fn();
  const f = createRendererStoreFixture({
    projects: [projectRecord({ path: "/project" })],
    client: { sessionChats: { inspect, compact } },
  });
  const sessionId = scope === "global" ? CAKE_CHAT_SESSION_ID : projectChatSessionId("/project");
  const owner = f.root.cakeChatCollectionStore.registry.load(sessionId);
  f.root.cakeChatCollectionStore.pendingSessions.markMaterialized(sessionId);
  function publish(context: CakeChatContextStatus, streaming = false) {
    act(() =>
      applyConversationSnapshot(owner.model, {
        sessionId,
        sessionFile: "/chat.sqlite",
        parts,
        models: [],
        thinkingLevel: "off",
        availableThinkingLevels: ["off"],
        streaming,
        diagnostics: [],
        commands: [],
        compatibility: { resources: [], diagnostics: [] },
        extensionUi: { statuses: [] },
        tree: [],
        usage: {
          tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          cost: 0,
          cakeChatContext: context,
        },
      }),
    );
  }
  publish(initial);
  const view = render(
    <Chat
      store={owner.conversationSessionStore.chatStore}
      compact
      embedded
      composerFocusEnabled={false}
    />,
  );
  return {
    inspect,
    compact,
    publish,
    [Symbol.dispose]() {
      view.unmount();
      f[Symbol.dispose]();
    },
  };
}

it.each(["global", "project-chat"] as const)(
  "opens the read-only Context Browser from %s token accounting with one described tooltip",
  async (scope) => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(at);
    using f = fixture(status, scope);
    const button = screen.getByRole("button", { name: "Browse context" });
    expect(button.closest("[title]")).toBeNull();
    expect(button.textContent).toBe("[Sys 5k · Mem 10k · Msgs 30k] · ≈45k/300k");
    expect(button.getAttribute("data-cache-state")).toBe("likely-warm");
    expect(button.getAttribute("aria-description")).toBe(
      "Cache: Likely warm\nExpires: ≈5 min\nNext: Continue",
    );
    fireEvent.mouseEnter(button);
    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip.textContent).toBe("Cache: Likely warm\nExpires: ≈5 min\nNext: Continue");
    expect(screen.getAllByRole("tooltip")).toHaveLength(1);
    fireEvent.mouseLeave(button);
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.mouseEnter(button);
    await screen.findByRole("tooltip");
    fireEvent.click(button);
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(await screen.findByRole("dialog", { name: "Context" })).toBeTruthy();
    expect(screen.getByText("Baseline (system + memory): ≈15,000 tokens.")).toBeTruthy();
    expect(screen.getByText(/Browsing earlier originals does not add them/)).toBeTruthy();
    expect(f.inspect).toHaveBeenCalledExactlyOnceWith(
      {
        sessionId: scope === "global" ? CAKE_CHAT_SESSION_ID : projectChatSessionId("/project"),
        kind: "context-outline",
      },
      expect.anything(),
    );
    expect(f.compact).not.toHaveBeenCalled();
  },
);

it("changes the next-message forecast at persisted-request expiry without invoking compaction on a timer", () => {
  vi.useFakeTimers();
  vi.setSystemTime(at);
  using f = fixture();
  const button = screen.getByRole("button", { name: "Browse context" });
  expect(button.getAttribute("data-cache-state")).toBe("likely-warm");
  act(() => vi.advanceTimersByTime(5 * 60_000));
  expect(button.getAttribute("data-cache-state")).toBe("likely-cold");
  expect(button.getAttribute("aria-description")).toBe(
    "Cache: Likely cold\nExpires: Expired\nNext: Summarize",
  );
  fireEvent.mouseEnter(button);
  act(() => vi.advanceTimersByTime(120));
  expect(screen.getByRole("tooltip").textContent).toBe(
    "Cache: Likely cold\nExpires: Expired\nNext: Summarize",
  );
  expect(f.compact).not.toHaveBeenCalled();
  f.publish(status);
  expect(button.getAttribute("data-cache-state")).toBe("likely-cold");
});

it("keeps missing cache metadata unknown and plans blocking preparation for the next input", () => {
  const missing = { ...status };
  delete missing.cache;
  using f = fixture(missing);
  const button = screen.getByRole("button", { name: "Browse context" });
  expect(button.getAttribute("data-cache-state")).toBe("unknown");
  expect(button.getAttribute("aria-description")).toBe(
    "Cache: Unknown\nExpires: Unknown\nNext: Summarize",
  );
  expect(f.compact).not.toHaveBeenCalled();
});

it.each(["global", "project-chat"] as const)(
  "presents %s preparation only in the activity row and restores normal activity",
  (scope) => {
    const parts: ConversationSnapshot["parts"] = [
      { id: "user", kind: "text", role: "user", text: "Continue", status: "complete" },
    ];
    using f = fixture(status, scope, parts);
    const expectActivity = (label: string) => {
      const indicator = screen.getByRole("status", { name: `${label} in progress` });
      expect(document.querySelectorAll('[data-slot="loading-state"]')).toHaveLength(1);
      expect(indicator.closest(".transcript")).not.toBeNull();
      expect(indicator.closest(".workbench-composer")).toBeNull();
      expect(screen.getAllByText(label)).toHaveLength(1);
    };
    // Forecasting a future summary must not create a running indicator.
    f.publish({ ...status, totalTokens: 300_000 });
    expect(screen.queryByRole("status")).toBeNull();
    f.publish(status, true);
    expectActivity("Churning");
    f.publish({ ...status, activity: "summarizing" }, true);
    expectActivity("Summarizing memory…");
    expect(screen.queryByText("Churning")).toBeNull();
    f.publish({ ...status, activity: "consolidating" }, true);
    expectActivity("Consolidating memory…");
    f.publish(status, true);
    expectActivity("Churning");
    f.publish(status);
    expect(screen.queryByRole("status")).toBeNull();
    // Preparation may be observed before streaming starts. Its end clears
    // the row directly from authority, including a failed or stopped turn.
    f.publish({ ...status, activity: "summarizing" });
    expectActivity("Summarizing memory…");
    f.publish(status);
    expect(screen.queryByRole("status")).toBeNull();
  },
);

it("uses the same activity row for preparation with an empty transcript", () => {
  using f = fixture();
  f.publish({ ...status, activity: "summarizing" });
  const indicator = screen.getByRole("status", { name: "Summarizing memory… in progress" });
  expect(indicator.closest(".transcript")).not.toBeNull();
  expect(screen.getAllByText("Summarizing memory…")).toHaveLength(1);
  f.publish(status, true);
  expect(screen.getByRole("status", { name: "Churning in progress" })).toBeTruthy();
  f.publish(status);
  expect(screen.queryByRole("status")).toBeNull();
});

it("shows actual preparation activity, a limit-triggered plan despite warm cache, and completed before/after detail", async () => {
  using f = fixture({ ...status, totalTokens: 300_000 });
  expect(
    screen.getByRole("button", { name: "Browse context" }).getAttribute("aria-description"),
  ).toContain("Next: Summarize (limit)");
  f.publish({ ...status, activity: "summarizing" });
  expect(screen.getByText("Summarizing memory…")).toBeTruthy();
  f.publish({ ...status, activity: "consolidating" });
  expect(screen.getByText("Consolidating memory…")).toBeTruthy();
  f.publish({
    ...status,
    lastSummary: { beforeTokens: 89_300, afterTokens: 45_000, reason: "limit", completedAt: at },
  });
  fireEvent.click(screen.getByRole("button", { name: "Browse context" }));
  expect(
    await screen.findByText("Last memory update: ≈89,300 → ≈45,000 tokens · limit."),
  ).toBeTruthy();
});
