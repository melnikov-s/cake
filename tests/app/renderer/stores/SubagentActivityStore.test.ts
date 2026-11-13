import { createStore, effect, mount, observable } from "r-state-tree";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UiPart } from "../../../../src/contracts/conversations/session-contract";
import {
  SubagentHandleId,
  type SubagentActivity,
} from "../../../../src/contracts/subagents/subagent-data";
import { SubagentCatalog } from "../../../../src/renderer/models/SubagentCatalog";
import { applySubagentUpdate } from "../../../../src/renderer/reducers/SubagentReducer";
import { SubagentActivityStore } from "../../../../src/renderer/stores/SubagentActivityStore";

// Renderer performance contract: an observation `clear` (subagents.loaded = false) ran
// on the main thread for every evicted parent, and each mounted worker chat re-parsed the
// whole parent transcript. UI text cannot expose this; count real Store work instead.
const parentSessionId = "parent";
const WORKERS = 40;
const FILLER_PARTS = 400;

const handleIdAt = (index: number) =>
  SubagentHandleId.make(`10000000-0000-4000-8000-${index.toString().padStart(12, "0")}`);

function activity(index: number, overrides: Partial<SubagentActivity> = {}): SubagentActivity {
  return {
    resolved: false,
    parentSessionId,
    anchorPartId: `spawn-${index}`,
    handleId: handleIdAt(index),
    revision: 1,
    task: `Task ${index}`,
    status: "running",
    resolvedModel: {
      requested: "current",
      source: "current",
      provider: "test",
      modelId: "model",
      thinkingLevel: "medium",
      fallbacks: [],
    },
    fastMode: false,
    streaming: true,
    parts: [],
    ...overrides,
  };
}

function parentTranscript(): UiPart[] {
  const parts: UiPart[] = [];
  for (let index = 0; index < WORKERS; index += 1)
    parts.push({
      id: `spawn-${index}`,
      kind: "tool",
      name: "cake",
      command: "subagents.start",
      input: JSON.stringify({ task: `Task ${index}` }),
      output: JSON.stringify({ handleId: handleIdAt(index), status: "running" }),
      state: "success",
    });
  for (let index = 0; index < FILLER_PARTS; index += 1)
    parts.push({
      id: `text-${index}`,
      kind: "text",
      role: "assistant",
      text: `Filler ${index}`,
      status: "complete",
    });
  return parts;
}

function setup() {
  const catalog = SubagentCatalog.create({ sessionId: parentSessionId });
  applySubagentUpdate(catalog, parentSessionId, {
    _tag: "Snapshot",
    revision: 1,
    parentSessionId,
    activities: Array.from({ length: WORKERS }, (_, index) => activity(index)),
    backgroundActive: true,
  });
  const transcript = observable({ parts: parentTranscript() });
  const counts = { partsReads: 0 };
  const store = mount(
    createStore(SubagentActivityStore, {
      sessionId: parentSessionId,
      model: catalog,
      parts: () => {
        counts.partsReads += 1;
        return transcript.parts;
      },
    }),
  );
  return { catalog, transcript, counts, store };
}

const disposers: Array<() => void> = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  vi.restoreAllMocks();
});

/** Mounted worker chats: each reads its own composer and error state, as the UI does. */
function observeEveryChat(store: SubagentActivityStore) {
  const evaluations = new Map<string, number>();
  for (let index = 0; index < WORKERS; index += 1) {
    const key = handleIdAt(index);
    disposers.push(
      effect(() => {
        const chat = store.chatStore(key);
        void chat?.composerVisible;
        void chat?.props.error?.();
        evaluations.set(key, (evaluations.get(key) ?? 0) + 1);
      }),
    );
  }
  return evaluations;
}

describe("SubagentActivityStore bounded work", () => {
  it("does no transcript or messaging work when an observation clears loaded state", () => {
    const { catalog, counts, store } = setup();
    const evaluations = observeEveryChat(store);
    const chats = store.chatStores.slice();
    // SAFETY: canMessage is a real private prototype method; the spy only counts calls.
    const canMessage = vi.spyOn(
      SubagentActivityStore.prototype as unknown as { canMessage(key: string): boolean },
      "canMessage",
    );
    counts.partsReads = 0;
    evaluations.clear();

    // models.ts `clear` for an evicted parent's subagents observation.
    catalog.loaded = false;
    catalog.observationError = undefined;
    expect({ partsReads: counts.partsReads, canMessage: canMessage.mock.calls.length }).toEqual({
      partsReads: 0,
      canMessage: 0,
    });
    expect(evaluations.size).toBe(0);
    expect(store.chatStores).toEqual(chats);

    // Repeated ticks with no change do nothing at all.
    for (let tick = 0; tick < 5; tick += 1) {
      catalog.loaded = false;
      catalog.observationError = undefined;
    }
    catalog.observationError = "Disconnected";
    catalog.observationError = undefined;
    catalog.loaded = true;
    expect(counts.partsReads).toBe(0);
    expect(canMessage).not.toHaveBeenCalled();
    expect(evaluations.size).toBe(0);
  });

  it("parses the parent transcript at most once for every worker chat lookup", () => {
    const { catalog, counts, store } = setup();
    void store.chatStores;
    catalog.loaded = false;
    counts.partsReads = 0;
    for (let index = 0; index < WORKERS; index += 1) {
      const key = handleIdAt(index);
      expect(store.chatStore(key)?.id).toBe(`subagent:${key}`);
      void store.run(key);
      void store.model(key);
      void store.resourceContext(key);
      void store.chatStore(key)?.composerVisible;
      void store.chatStore(key)?.attachmentImages;
    }
    expect(counts.partsReads).toBeLessThanOrEqual(1);
  });

  it("keeps chat identity and reconciles nothing when one worker's status changes", () => {
    const { catalog, store } = setup();
    const chats = store.chatStores.slice();
    // Reconciling a new chat list replaces every chat's prop closures.
    const props = chats.map((chat) => chat.props.composerVisible);
    applySubagentUpdate(catalog, parentSessionId, {
      _tag: "Activity",
      revision: 2,
      parentSessionId,
      activity: activity(3, { status: "complete", streaming: false, revision: 2 }),
    });
    expect(store.chatStores).toEqual(chats);
    expect(store.chatStores.every((chat, index) => chat === chats[index])).toBe(true);
    expect(chats.every((chat, index) => chat.props.composerVisible === props[index])).toBe(true);
    // Queueing one worker re-props only that worker's chat.
    applySubagentUpdate(catalog, parentSessionId, {
      _tag: "Activity",
      revision: 2,
      parentSessionId,
      activity: activity(4, { status: "queued", revision: 2 }),
    });
    expect(store.chatStore(handleIdAt(4))?.props.steerQueuedPrompt).toBeUndefined();
    expect(store.chatStore(handleIdAt(4))).toBe(chats[4]);
    expect(
      chats.every((chat, index) => index === 4 || chat.props.composerVisible === props[index]),
    ).toBe(true);
    applySubagentUpdate(catalog, parentSessionId, {
      _tag: "Activity",
      revision: 2,
      parentSessionId,
      activity: activity(4, { status: "running", revision: 3 }),
    });
    expect(store.chatStore(handleIdAt(4))?.props.steerQueuedPrompt).toBeTypeOf("function");
    // Adding a worker creates exactly one new chat and keeps the others.
    applySubagentUpdate(catalog, parentSessionId, {
      _tag: "Activity",
      revision: 2,
      parentSessionId,
      activity: activity(WORKERS),
    });
    expect(store.chatStores).toHaveLength(WORKERS + 1);
    expect(store.chatStores.slice(0, WORKERS).every((chat, index) => chat === chats[index])).toBe(
      true,
    );
  });

  it("still updates messaging when a relevant run changes", () => {
    const { catalog, store } = setup();
    const key = handleIdAt(2);
    const visible: boolean[] = [];
    const otherVisible: boolean[] = [];
    disposers.push(
      effect(() => {
        visible.push(store.chatStore(key)?.composerVisible ?? false);
      }),
      effect(() => {
        otherVisible.push(store.chatStore(handleIdAt(7))?.composerVisible ?? false);
      }),
    );
    expect(store.chatStore(key)?.props.placeholder()).toBe("Queue a message…");
    applySubagentUpdate(catalog, parentSessionId, {
      _tag: "Activity",
      revision: 2,
      parentSessionId,
      activity: activity(2, { status: "complete", streaming: false, revision: 2 }),
    });
    expect(store.chatStore(key)?.props.placeholder()).toBe("Message this subagent…");
    expect(store.chatStore(key)?.props.canSubmit("hello")).toBe(true);
    applySubagentUpdate(catalog, parentSessionId, {
      _tag: "Removed",
      parentSessionId,
      revision: 3,
      handleId: key,
    });
    expect(visible.filter((value, index) => value !== visible[index - 1])).toEqual([true, false]);
    // Another worker's composer is not re-evaluated for this worker's changes.
    expect(otherVisible).toEqual([true]);
    expect(store.chatStore(key)?.props.placeholder()).toBe("Subagent unavailable");
    expect(store.chatStore(key)?.props.canSubmit("hello")).toBe(false);
    expect(store.chatStore(key)?.props.userMessagePresentation).toBeUndefined();
  });

  it("shows the unmapped-worker explanation for the current loading state", () => {
    const { catalog, transcript, store } = setup();
    // Drop live activity for worker 5 so only its parent report remains.
    applySubagentUpdate(catalog, parentSessionId, {
      _tag: "Snapshot",
      revision: 2,
      parentSessionId,
      activities: Array.from({ length: WORKERS }, (_, index) => activity(index)).filter(
        (_, index) => index !== 5,
      ),
      backgroundActive: true,
    });
    void transcript;
    const key = handleIdAt(5);
    const errors: Array<string | undefined> = [];
    disposers.push(effect(() => void errors.push(store.chatStore(key)?.error?.message)));
    catalog.loaded = false;
    catalog.observationError = "Disconnected";
    expect(store.run(key)?.error).toBe("Disconnected");
    expect(errors).toEqual([
      expect.stringContaining("no retained handle-to-Pi mapping"),
      "The saved subagent conversation is still loading.",
      "Disconnected",
    ]);
  });
});
