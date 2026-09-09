import { createStore, mount, observable, type StoreSnapshot } from "r-state-tree";
import { describe, expect, it } from "vitest";
import type { ProjectSessionStore } from "../../../../src/renderer/stores/ProjectSessionStore";
import { SessionObservationRetentionStore } from "../../../../src/renderer/stores/SessionObservationRetentionStore";

function session(sessionId: string, running = false) {
  return {
    sessionId,
    model: {
      streaming: running,
      activeTurnIds: [],
      backgroundWorkActive: false,
    },
  } as unknown as ProjectSessionStore;
}

function fixture(options?: { snapshot?: StoreSnapshot; selected?: string; visible?: string }) {
  const sessions: ProjectSessionStore[] = observable([]);
  const store = mount(
    createStore(SessionObservationRetentionStore, {
      sessions: () => sessions,
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

  it("keeps selected, visible, and running pins outside the 20-session idle LRU", () => {
    const { sessions, store } = fixture({ selected: "selected", visible: "visible" });
    for (const item of [session("selected"), session("visible"), session("running", true)]) {
      sessions.push(item);
      store.materialize(item.sessionId);
    }
    for (let index = 0; index < 21; index += 1) {
      const item = session(`idle-${index}`);
      sessions.push(item);
      store.materialize(item.sessionId);
    }

    expect(store.sessions).toHaveLength(23);
    expect(store.sessions.map((item) => item.sessionId)).toEqual(
      expect.arrayContaining(["selected", "visible", "running", "idle-20"]),
    );
    expect(store.sessions.map((item) => item.sessionId)).not.toContain("idle-0");

    store[Symbol.dispose]();
  });
});
