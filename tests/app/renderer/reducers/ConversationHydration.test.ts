import { applySnapshot, effect, onSnapshot, toSnapshot } from "r-state-tree";
import { afterEach, expect, it, vi } from "vitest";
import type { ConversationSnapshot } from "../../../../src/contracts/conversations/conversation-data";
import { Conversation } from "../../../../src/renderer/models/Conversation";
import { Message } from "../../../../src/renderer/models/Message";
import {
  applyConversationSnapshot,
  unloadConversationProjection,
} from "../../../../src/renderer/reducers/ConversationReducer";
import {
  messageSnapshotChanges,
  messageSnapshots,
} from "../../../../src/renderer/reducers/SessionPartReducer";
import { conversationHydrationFixture } from "../fixtures/conversation-hydration-fixture";

vi.mock("r-state-tree", async (importOriginal) => {
  const actual = await importOriginal<typeof import("r-state-tree")>();
  return { ...actual, applySnapshot: vi.fn(actual.applySnapshot) };
});

vi.mock("../../../../src/renderer/reducers/SessionPartReducer", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../../src/renderer/reducers/SessionPartReducer")>();
  return {
    ...actual,
    messageSnapshotChanges: vi.fn(actual.messageSnapshotChanges),
  };
});

afterEach(() => {
  vi.mocked(applySnapshot).mockClear();
  vi.mocked(messageSnapshotChanges).mockClear();
});

function hydratedFieldCount() {
  // Each supplied field enters the installed public child-snapshot loader.
  // Count that actual boundary, not assumed React commits or Model creation.
  return vi.mocked(applySnapshot).mock.calls.reduce((count, [model, snapshot]) => {
    if (!(model instanceof Conversation) || !snapshot || !("parts" in snapshot)) return count;
    if (!Array.isArray(snapshot.parts)) return count;
    return (
      count +
      snapshot.parts.reduce(
        (fields: number, part: unknown) =>
          fields + (part !== null && typeof part === "object" ? Object.keys(part).length : 0),
        0,
      )
    );
  }, 0);
}

function applyFullFields(model: Conversation, snapshot: ConversationSnapshot) {
  // The previous valid-snapshot path: same decoder, mapping, reconciliation and
  // rollback, with no equal-field pruning. No alternate implementation in production.
  vi.mocked(messageSnapshotChanges).mockImplementationOnce((parts, ownerId) =>
    messageSnapshots(parts, ownerId),
  );
  applyConversationSnapshot(model, snapshot);
}

it("measures bounded cold, repeated, changed and reopened snapshot hydration", () => {
  const snapshot = conversationHydrationFixture();
  using model = Conversation.create({ sessionId: snapshot.sessionId });
  const create = vi.spyOn(Message, "create");
  const counts: Record<string, { fields: number; created: number }> = {};
  function apply(label: string, value = snapshot) {
    vi.mocked(applySnapshot).mockClear();
    create.mockClear();
    applyConversationSnapshot(model, value);
    counts[label] = { fields: hydratedFieldCount(), created: create.mock.calls.length };
  }
  try {
    apply("cold");
    const original = model.parts.slice();
    apply("same", structuredClone(snapshot));
    expect(model.parts.every((part, index) => part === original[index])).toBe(true);
    const changed = structuredClone(snapshot);
    const last = changed.parts.at(-1)!;
    if (last.kind !== "text") throw new Error("Expected final assistant text");
    changed.parts[changed.parts.length - 1] = { ...last, text: "Changed answer" };
    apply("changed", changed);
    expect(model.parts.at(-1)?.value).toMatchObject({ text: "Changed answer" });
    expect(model.parts.every((part, index) => part === original[index])).toBe(true);
    unloadConversationProjection(model);
    apply("reopened");
    expect(model.parts.every((part, index) => part !== original[index])).toBe(true);
    using expected = Conversation.create({ sessionId: snapshot.sessionId });
    applyFullFields(expected, snapshot);
    expect(toSnapshot(model)).toEqual(toSnapshot(expected));
    expect(counts).toEqual({
      cold: { fields: 2540, created: 240 },
      same: { fields: 260, created: 0 },
      changed: { fields: 261, created: 0 },
      reopened: { fields: 2540, created: 240 },
    });
  } finally {
    create.mockRestore();
  }
});

it("matches full hydration, keyed identity and notifications through authoritative replacements", () => {
  using model = Conversation.create({ sessionId: "hydration" });
  using reference = Conversation.create({ sessionId: "hydration" });
  const seen: unknown[][] = [[], []];
  const snapshots: unknown[][] = [[], []];
  const stops = [model, reference].flatMap((value, index) => [
    effect(() => {
      seen[index]!.push(value.uiParts);
    }),
    onSnapshot(value, (snapshot) => {
      snapshots[index]!.push(snapshot);
    }),
  ]);
  const initial = conversationHydrationFixture(8);
  const metadata = structuredClone(initial);
  const text = metadata.parts[0]!;
  const tool = metadata.parts[2]!;
  if (text.kind !== "text" || tool.kind !== "tool") throw new Error("Invalid fixture");
  metadata.parts[0] = {
    ...text,
    renderAs: "markdown",
    requestedAt: 10,
    responseToTurnIds: ["turn"],
  };
  metadata.parts[2] = {
    ...tool,
    interviewResult: {
      interviewId: "call",
      cancelled: false,
      value: { choices: [null, "one", 7, false] },
    },
  };
  const reordered = structuredClone(initial);
  reordered.parts = [
    reordered.parts[3]!,
    reordered.parts[2]!,
    reordered.parts[0]!,
    { id: "new", kind: "notice", tone: "warning", title: "New notice" },
  ];
  const kindChanged = structuredClone(reordered);
  kindChanged.parts[0] = {
    id: kindChanged.parts[0]!.id,
    kind: "context",
    title: "Changed kind",
    text: "Authoritative replacement",
  };
  try {
    for (const next of [
      initial,
      structuredClone(initial),
      metadata,
      structuredClone(initial),
      reordered,
      kindChanged,
    ]) {
      const previous = new Map(model.parts.map((part) => [part.id, part]));
      applyConversationSnapshot(model, next);
      applyFullFields(reference, structuredClone(next));
      expect(toSnapshot(model)).toEqual(toSnapshot(reference));
      expect(model.uiParts).toEqual(reference.uiParts);
      expect(seen[0]).toEqual(seen[1]);
      expect(snapshots[0]).toEqual(snapshots[1]);
      for (const part of model.parts)
        if (previous.has(part.id)) expect(part).toBe(previous.get(part.id));
    }
    const before = toSnapshot(model);
    const duplicate = { ...kindChanged, parts: [kindChanged.parts[0]!, kindChanged.parts[0]!] };
    expect(() => applyConversationSnapshot(model, duplicate)).toThrow(/duplicate ids/);
    expect(toSnapshot(model)).toEqual(before);
    const invalid = structuredClone(initial);
    Object.assign(invalid.parts[0]!, { status: "invalid" });
    expect(() => applyConversationSnapshot(model, invalid)).toThrow();
    expect(toSnapshot(model)).toEqual(before);
  } finally {
    stops.forEach((stop) => stop());
  }
});

it("never reuses another session's messages or skips a field changed by a live delta", () => {
  using first = Conversation.create({ sessionId: "first" });
  using second = Conversation.create({ sessionId: "second" });
  const snapshot = conversationHydrationFixture(4, "first");
  applyConversationSnapshot(first, snapshot);
  const part = first.parts[0]!;
  const uiPart = snapshot.parts[0]!;
  if (uiPart.kind !== "text") throw new Error("Invalid fixture");
  part.update({ ...uiPart, text: "Live delta", renderAs: "markdown" });
  applyConversationSnapshot(second, { ...snapshot, sessionId: "second" });
  expect(second.parts[0]).not.toBe(part);
  expect(second.parts[0]!.id).not.toBe(part.id);
  expect(first.parts[0]!.text).toBe("Live delta");
  applyConversationSnapshot(first, structuredClone(snapshot));
  expect(first.parts[0]).toBe(part);
  expect(part.text).toBe(uiPart.text);
  expect(part.renderAs).toBeUndefined();
  expect(first.uiParts).toEqual(second.uiParts);
});
