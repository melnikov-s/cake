/** @vitest-environment jsdom */
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type {
  ConversationSnapshot,
  UiPart,
} from "../../../src/contracts/conversations/session-contract";
import type { Client } from "../../../src/renderer/client/Client";
import { ChatTranscript } from "../../../src/renderer/components/chat-transcript";
import { applyConversationUpdate } from "../../../src/renderer/reducers/ConversationReducer";
import { createRendererStoreFixture } from "./renderer-store-fixture";
import { projectRecord, sessionSummary } from "./fixtures/catalog-fixtures";
import { scrollTranscriptEarlier } from "./scroll-transcript-earlier";

const part = (id: string): UiPart => ({
  kind: "text",
  id,
  role: "user",
  text: id,
  status: "complete",
});
const snapshot = (sessionId: string, parts: UiPart[]): ConversationSnapshot => ({
  sessionId,
  workspacePath: "/project",
  sessionFile: `/project/${sessionId}.jsonl`,
  parts,
  historyCursor: "older-1",
  models: [],
  thinkingLevel: "off",
  availableThinkingLevels: ["off"],
  streaming: false,
  diagnostics: [],
  commands: [],
  compatibility: { resources: [], diagnostics: [] },
  extensionUi: { statuses: [] },
  tree: [],
});
afterEach(cleanup);

it("ordinary sessions admit one page, serialize reads, preserve live rollover and stop at exhaustion", async () => {
  const pending = Promise.withResolvers<Awaited<ReturnType<Client["sessionChats"]["history"]>>>();
  const history = vi
    .fn<Client["sessionChats"]["history"]>()
    .mockReturnValueOnce(pending.promise)
    .mockResolvedValueOnce({ parts: [part("oldest")], cursor: undefined });
  using fixture = createRendererStoreFixture({
    client: { sessionChats: { history } },
    projects: [projectRecord({ path: "/project", name: "Project" })],
    sessions: [sessionSummary({ sessionId: "session", projectPath: "/project" })],
  });
  const session = fixture.root.sessionRegistry.load("session", "/project");
  const publish = (revision: number, parts: UiPart[]) =>
    applyConversationUpdate(session.model, {
      _tag: "Snapshot",
      revision,
      snapshot: snapshot("session", parts),
    });
  publish(1, [part("recent")]);
  const store = session.conversationSessionStore.chatStore;
  const view = render(<ChatTranscript store={store} virtualized={false} />);
  try {
    expect(history).not.toHaveBeenCalled();
    scrollTranscriptEarlier(screen.getByText("Earlier messages"));
    expect(history).toHaveBeenCalledExactlyOnceWith(
      { sessionId: "session", cursor: "older-1" },
      { signal: expect.any(AbortSignal) },
    );
    expect(screen.getByRole("status").textContent).toBe("Loading earlier messages…");
    scrollTranscriptEarlier(screen.getByText("Loading earlier messages…"));
    await act(async () => {
      await store.history!.load();
    });
    expect(history).toHaveBeenCalledOnce();
    act(() => publish(2, [part("recent"), part("streamed")]));
    await act(async () =>
      pending.resolve({ parts: [part("older"), part("recent")], cursor: "older-2" }),
    );
    expect(session.model.uiParts.map((p) => p.id)).toEqual(["older", "recent", "streamed"]);
    expect(history).toHaveBeenCalledOnce();
    scrollTranscriptEarlier(screen.getByText("Earlier messages"));
    await screen.findByText("oldest");
    expect(history).toHaveBeenCalledTimes(2);
    expect(history.mock.calls[1]?.[0]).toEqual({ sessionId: "session", cursor: "older-2" });
    expect(store.history!.hasMore).toBe(false);
    await store.history!.load();
    expect(history).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("Earlier messages")).toBeNull();
  } finally {
    view.unmount();
  }
});

it("switching/disposal cannot prepend a stale page to another conversation", async () => {
  const pending = Promise.withResolvers<Awaited<ReturnType<Client["sessionChats"]["history"]>>>();
  const history = vi.fn<Client["sessionChats"]["history"]>(() => pending.promise);
  using fixture = createRendererStoreFixture({
    client: { sessionChats: { history } },
    projects: [projectRecord({ path: "/project", name: "Project" })],
    sessions: ["first", "second"].map((sessionId) =>
      sessionSummary({ sessionId, projectPath: "/project" }),
    ),
  });
  const first = fixture.root.sessionRegistry.load("first", "/project");
  const second = fixture.root.sessionRegistry.load("second", "/project");
  for (const session of [first, second])
    applyConversationUpdate(session.model, {
      _tag: "Snapshot",
      revision: 1,
      snapshot: snapshot(session.sessionId, [part(session.sessionId)]),
    });
  const beforePrepend = vi.fn();
  const read = first.history.load(beforePrepend);
  expect(history).toHaveBeenCalledOnce();
  expect(second.model.uiParts.map((p) => p.id)).toEqual(["second"]);
  fixture[Symbol.dispose]();
  expect(history.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  pending.resolve({ parts: [part("stale")], cursor: undefined });
  await read;
  expect(beforePrepend).not.toHaveBeenCalled();
  expect(first.model.earlierParts).toHaveLength(0);
  expect(second.model.earlierParts).toHaveLength(0);
});
