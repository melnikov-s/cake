/** @vitest-environment jsdom */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { applySnapshot } from "r-state-tree";
import { observer } from "r-state-tree/react";
import { afterEach, expect, it, vi } from "vitest";
import { CAKE_CHAT_SESSION_ID } from "../../../src/ipc/cake-chat-data";
import type {
  RequestInspectionEntry,
  RequestInspectionResult,
} from "../../../src/contracts/conversations/request-inspection";
import { RequestInspector } from "../../../src/renderer/components/request-inspector";
import { SidebarCakeChatGroup } from "../../../src/renderer/components/sidebar-cake-chat-group";
import type { Client } from "../../../src/renderer/client/Client";
import type { RootStore } from "../../../src/renderer/stores/RootStore";
import { createRendererStoreFixture } from "./renderer-store-fixture";

const Surface = observer(function Surface({ root }: { root: RootStore }) {
  const chat = root.cakeChatCollectionStore.activeSession;
  return (
    <>
      <SidebarCakeChatGroup
        cakeChat={root.cakeChatCollectionStore}
        shell={root.appShellStore}
        onOpenCakeChat={(id) => void root.navigationStore.openCakeChat(id)}
      />
      {chat && <RequestInspector store={chat.requestInspectorStore} />}
    </>
  );
});
afterEach(cleanup);
const empty = {
  history: { entries: [], evicted: 0, maxEntries: 40, maxBytes: 67108864 },
} satisfies RequestInspectionResult;
const entry: RequestInspectionEntry = {
  id: "request-1",
  callId: "call-1",
  sessionId: CAKE_CHAT_SESSION_ID,
  capturedAt: "2026-04-01T12:00:00Z",
  provider: "fixture",
  modelId: "fixture",
  api: "openai-completions",
  purpose: "coordinator",
  boundary: "http-body",
  state: "completed",
  attempt: 1,
  byteSize: 70_000,
  settings: '{"temperature":0.2}',
};

it("opens permanent Cake Chat's latest immutable request, searches full large collapsed content, switches requests and clears without prompting", async () => {
  const long = `${"Long context. ".repeat(6000)}NEEDLE_AT_END`;
  const raw =
    JSON.stringify({
      messages: [{ role: "system", content: long }],
      tools: [{ name: "cake" }],
    }) + "\n\n";
  const older = {
    ...entry,
    id: "request-older",
    boundary: "provider-payload" as const,
    limitation: "NOT an exact body",
  };
  let entries = [older, entry];
  const inspect = vi.fn<Client["cakeChats"]["requestInspection"]>(
    async (input): Promise<RequestInspectionResult> => {
      if (input.action === "clear") entries = [];
      const history = { ...empty.history, entries };
      if (input.action === "payload") {
        const selected = entries.find((item) => item.id === input.id)!;
        return { history, payload: { entry: selected, raw } };
      }
      return { history };
    },
  );
  using fixture = createRendererStoreFixture({
    client: { cakeChats: { requestInspection: inspect } },
  });
  applySnapshot(fixture.models.cakeChatCatalog, { loaded: true, sessions: [] });
  const user = userEvent.setup();
  const view = render(<Surface root={fixture.root} />);
  try {
    await user.click(screen.getByRole("button", { name: /^Cake Chat$/ }));
    await user.click(screen.getByRole("button", { name: "Inspect context" }));
    await screen.findByText("Exact serialized HTTP request body");
    expect(screen.getByRole("combobox", { name: "Captured request" })).toHaveProperty(
      "value",
      entry.id,
    );
    expect(inspect.mock.calls.map(([input]) => input)).toEqual([
      { sessionId: CAKE_CHAT_SESSION_ID, action: "history" },
      { sessionId: CAKE_CHAT_SESSION_ID, action: "payload", id: entry.id },
    ]);
    const search = screen.getByRole("textbox", { name: "Search captured context" });
    await user.type(search, "NEEDLE_AT_END");
    expect(screen.getByText(long).textContent).toBe(long);
    await user.click(screen.getByRole("button", { name: "Copy raw" }));
    await screen.findByText("Raw payload copied");
    expect(await navigator.clipboard.readText()).toBe(raw);
    await user.click(screen.getByRole("button", { name: "Raw view" }));
    expect(document.querySelector('[data-streamdown="code-block-body"] code')?.textContent).toBe(
      raw,
    );
    await user.click(screen.getByRole("button", { name: "Structured view" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Captured request" }), older.id);
    await screen.findByText("Intermediate or unavailable capture — NOT an exact outbound body");
    await user.click(screen.getByRole("button", { name: "Clear history" }));
    await screen.findByText(/No captured requests yet/);
    expect(fixture.root.cakeChatCollectionStore.activeSession?.model.uiParts).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(
      fixture.root.cakeChatCollectionStore.activeSession?.requestInspectorStore.payload,
    ).toBeUndefined();
  } finally {
    view.unmount();
  }
});

it("shows loading and a read error, then refreshes empty history without invoking any other client capability", async () => {
  let reject!: (error: Error) => void;
  const pending = new Promise<RequestInspectionResult>((_resolve, fail) => {
    reject = fail;
  });
  const inspect = vi.fn().mockReturnValueOnce(pending).mockResolvedValue(empty);
  using fixture = createRendererStoreFixture({
    client: { cakeChats: { requestInspection: inspect } },
  });
  applySnapshot(fixture.models.cakeChatCatalog, { loaded: true, sessions: [] });
  const user = userEvent.setup();
  const view = render(<Surface root={fixture.root} />);
  try {
    await user.click(screen.getByRole("button", { name: /^Cake Chat$/ }));
    await user.click(screen.getByRole("button", { name: "Inspect context" }));
    expect(screen.getByRole("status").textContent).toContain("Loading captured context");
    reject(new Error("Captured request unavailable"));
    await screen.findByRole("alert");
    expect(screen.getByRole("alert").textContent).toContain("Captured request unavailable");
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    await screen.findByText(/No captured requests yet/);
    expect(inspect).toHaveBeenCalledTimes(2);
  } finally {
    view.unmount();
  }
});

it("discards a late payload after closing and labels oversize captures with disabled raw export", async () => {
  let finish!: (result: RequestInspectionResult) => void;
  const pending = new Promise<RequestInspectionResult>((resolve) => {
    finish = resolve;
  });
  const oversized = {
    ...entry,
    limitation: "Full body exceeds local retention limit and was not retained",
  };
  const result = {
    history: { ...empty.history, entries: [oversized] },
    payload: { entry: oversized },
  } satisfies RequestInspectionResult;
  const inspect = vi
    .fn()
    .mockResolvedValueOnce({ history: result.history })
    .mockReturnValueOnce(pending)
    .mockResolvedValue(result);
  using fixture = createRendererStoreFixture({
    client: { cakeChats: { requestInspection: inspect } },
  });
  applySnapshot(fixture.models.cakeChatCatalog, { loaded: true, sessions: [] });
  const user = userEvent.setup();
  const view = render(<Surface root={fixture.root} />);
  try {
    await user.click(screen.getByRole("button", { name: /^Cake Chat$/ }));
    await user.click(screen.getByRole("button", { name: "Inspect context" }));
    await waitFor(() => expect(inspect).toHaveBeenCalledTimes(2));
    await user.click(screen.getByRole("button", { name: "Close" }));
    finish(result);
    await user.click(screen.getByRole("button", { name: "Inspect context" }));
    await screen.findByText(oversized.limitation);
    expect(screen.getByRole("button", { name: "Export raw" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Copy raw" })).toHaveProperty("disabled", true);
  } finally {
    view.unmount();
  }
});
