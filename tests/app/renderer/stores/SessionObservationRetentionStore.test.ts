import { createStore, mount, observable, type StoreSnapshot } from "r-state-tree";
import { describe, expect, it, vi } from "vitest";
import type { ProjectSessionStore } from "../../../../src/renderer/stores/ProjectSessionStore";
import { SessionObservationRetentionStore } from "../../../../src/renderer/stores/SessionObservationRetentionStore";

function session(sessionId: string, running = false) {
  return {
    sessionId,
    model: {
      streaming: running,
      activeTurnIds: [],
    },
    subagentActivityStore: { activeRuns: [] },
  } as unknown as ProjectSessionStore;
}

function fixture(options?: { snapshot?: StoreSnapshot; selected?: string; visible?: string }) {
  const sessions: ProjectSessionStore[] = observable([]);
  const store = mount(
    createStore(SessionObservationRetentionStore, {
      findSession: (sessionId) => sessions.find((item) => item.sessionId === sessionId),
      isActive: (sessionId) => sessionId === options?.selected,
      isVisible: (sessionId) => sessionId === options?.visible,
    }),
    options?.snapshot ? { snapshot: options.snapshot } : undefined,
  );
  return { sessions, store };
}

describe("SessionObservationRetentionStore", () => {
  it("does not restore process-local warm demand for persisted materialized sessions", () => {
    const { sessions, store } = fixture({
      snapshot: {
        state: { materializedSessionIds: ["one", "two"] },
        children: {},
      },
    });
    sessions.push(session("one"), session("two"));

    expect(store.sessions).toEqual([]);
    store.retain("two");
    expect(store.sessions.map((item) => item.sessionId)).toEqual(["two"]);

    store[Symbol.dispose]();
  });

  it("looks up only materialized sessions when trimming the warm set", () => {
    const sessions = observable(
      Array.from({ length: 5 }, (_, index) => session(`session-${index}`)),
    );
    const findSession = vi.fn((sessionId: string) =>
      sessions.find((item) => item.sessionId === sessionId),
    );
    const store = mount(
      createStore(SessionObservationRetentionStore, {
        findSession,
        isActive: () => false,
      }),
    );
    for (const item of sessions) store.materialize(item.sessionId);

    findSession.mockClear();
    store.retain("session-0");
    expect(new Set(findSession.mock.calls.map(([sessionId]) => sessionId))).toEqual(
      new Set(sessions.map((item) => item.sessionId)),
    );
    store[Symbol.dispose]();
  });

  it("keeps selected, visible, and running pins outside the four-session idle LRU", () => {
    const { sessions, store } = fixture({ selected: "selected", visible: "visible" });
    for (const item of [session("selected"), session("visible"), session("running", true)]) {
      sessions.push(item);
      store.materialize(item.sessionId);
    }
    for (let index = 0; index < 5; index += 1) {
      const item = session(`idle-${index}`);
      sessions.push(item);
      store.materialize(item.sessionId);
    }

    expect(store.sessions).toHaveLength(7);
    expect(store.sessions.map((item) => item.sessionId)).toEqual(
      expect.arrayContaining(["selected", "visible", "running", "idle-4"]),
    );
    expect(store.sessions.map((item) => item.sessionId)).not.toContain("idle-0");

    store[Symbol.dispose]();
  });
});
