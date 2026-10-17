import { Schema } from "effect";
import type { StoreSnapshot } from "r-state-tree";

const single = (child: StoreSnapshot["children"][string] | undefined) =>
  child && !Array.isArray(child) ? child : undefined;
const ids = (state: StoreSnapshot["state"], field: string) => {
  const decoded = Schema.decodeUnknownResult(Schema.Array(Schema.String))(state[field]);
  return decoded._tag === "Success" ? decoded.success : [];
};
const summarySchema = Schema.Struct({
  title: Schema.String,
  createdAt: Schema.String,
  modifiedAt: Schema.String,
  messageCount: Schema.Number,
  resolved: Schema.Boolean,
});
const phaseSchema = Schema.Union([
  Schema.Struct({ phase: Schema.Literals(["prepared", "staged", "submitting"]) }),
  Schema.Struct({ phase: Schema.Literal("unlisted"), summary: summarySchema }),
]);
const legacySummarySchema = Schema.Struct({
  name: Schema.optionalKey(Schema.String),
  fallbackTitle: Schema.optionalKey(Schema.String),
  createdAt: Schema.String,
  modifiedAt: Schema.String,
  messageCount: Schema.Number,
});

/** Pending lifecycle snapshot v0 -> v1. Runs before mounting; no legacy Store API remains. */
export function migratePendingSessions(snapshot: StoreSnapshot): StoreSnapshot {
  const registry = single(snapshot.children.sessionRegistry);
  const pending = registry && single(registry.children.pendingSessions);
  if (!registry || !pending) return snapshot;
  const state = { ...pending.state };
  const conversations = pending.children.conversations;
  const children = Array.isArray(conversations) ? conversations : [];
  if (state.lifecycleVersion !== 1) {
    const temporary = new Set(ids(state, "temporarySessionIds"));
    const staged = new Set(ids(state, "stagedSessionIds"));
    const unlisted = new Set(ids(state, "unlistedNewSessionIds"));
    const sessionsById: Record<string, Schema.Schema.Type<typeof phaseSchema>> = {};
    for (const id of new Set([...ids(state, "conversationIds"), ...temporary, ...unlisted])) {
      if (temporary.has(id)) sessionsById[id] = { phase: staged.has(id) ? "staged" : "prepared" };
      else if (unlisted.has(id)) {
        const decoded = Schema.decodeUnknownResult(legacySummarySchema)(
          children.find((child) => child.key === id)?.state,
        );
        if (decoded._tag !== "Success") continue;
        const facts = decoded.success;
        sessionsById[id] = {
          phase: "unlisted",
          summary: {
            title: facts.name ?? facts.fallbackTitle ?? "New chat",
            createdAt: facts.createdAt,
            modifiedAt: facts.modifiedAt,
            messageCount: facts.messageCount,
            resolved: false,
          },
        };
      }
    }
    state.sessionsById = sessionsById;
    state.lifecycleVersion = 1;
    for (const field of [
      "conversationIds",
      "temporarySessionIds",
      "stagedSessionIds",
      "submittingSessionIds",
      "unlistedNewSessionIds",
    ])
      delete state[field];
  }
  // An interrupted renderer request is no longer submitting in a fresh window.
  const decoded = Schema.decodeUnknownResult(Schema.Record(Schema.String, phaseSchema))(
    state.sessionsById,
  );
  if (decoded._tag === "Success") {
    state.sessionsById = Object.fromEntries(
      Object.entries(decoded.success).map(([id, entry]) => [
        id,
        entry.phase === "submitting" ? { phase: "staged" } : entry,
      ]),
    );
  }
  return {
    ...snapshot,
    children: {
      ...snapshot.children,
      sessionRegistry: {
        ...registry,
        children: {
          ...registry.children,
          pendingSessions: { ...pending, state },
        },
      },
    },
  };
}
