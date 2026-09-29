import type { SavedDraft } from "../../../src/domain/project-sessions/saved-draft-data";
import type { SavedDraftClient } from "../../../src/renderer/stores/ProjectPendingSessionsStore";

type SavedDraftCreateInput = Parameters<SavedDraftClient["create"]>[0];

export interface FakeSavedDrafts {
  readonly client: SavedDraftClient;
  /** Main-owned records keyed by Session ID, as the Saved Draft storage would hold them. */
  readonly records: Map<string, SavedDraft>;
  /** The snapshot main would push through `savedDrafts.observe`. */
  snapshot(): SavedDraft[];
  /**
   * Holds the next activation after its `activating` claim until `release` is called, so a test
   * can observe the in-flight state deterministically.
   */
  holdActivation(): { claimed: Promise<SavedDraft>; release(): void };
}

/**
 * In-memory Saved Draft authority with the revision and status transitions of main's
 * `SavedDraftStorage`: `saved` → `activating` (claim) → `activated` (completion).
 */
export function fakeSavedDrafts(now = () => "2026-01-01T00:00:00.000Z"): FakeSavedDrafts {
  const records = new Map<string, SavedDraft>();
  let gate: { wait: Promise<void>; claimed: (record: SavedDraft) => void } | undefined;

  const current = (sessionId: string, expectedRevision: number, operation: string) => {
    const record = records.get(sessionId);
    if (!record) throw new Error(`Saved Draft was removed (${operation})`);
    if (record.revision !== expectedRevision)
      throw new Error(`Saved Draft revision conflict (${operation})`);
    return record;
  };
  const store = (record: SavedDraft) => {
    records.set(record.sessionId, record);
    return record;
  };

  const client: SavedDraftClient = {
    list: async () => [...records.values()],
    create: async (input: SavedDraftCreateInput) => {
      const timestamp = now();
      return store({
        sessionId: input.sessionId ?? crypto.randomUUID(),
        projectPath: input.projectPath,
        workingDirectory: input.projectPath,
        title: input.title,
        text: input.text,
        attachments: [...input.attachments],
        ...(input.configuration ? { configuration: input.configuration } : null),
        labelIds: [...(input.labelIds ?? [])],
        resolved: input.resolved ?? false,
        createdAt: input.createdAt ?? timestamp,
        modifiedAt: input.modifiedAt ?? timestamp,
        revision: 1,
        status: "saved",
      });
    },
    update: async (record, expectedRevision) => {
      current(record.sessionId, expectedRevision, "update");
      return store({ ...record, revision: expectedRevision + 1, modifiedAt: now() });
    },
    remove: async (sessionId, expectedRevision) => {
      current(sessionId, expectedRevision, "remove");
      records.delete(sessionId);
    },
    recoverUncertain: async (sessionId, expectedRevision) => {
      const record = current(sessionId, expectedRevision, "recoverUncertain");
      return store({ ...record, revision: record.revision + 1, status: "saved" });
    },
    activate: async ({ sessionId, expectedRevision, workingDirectory }) => {
      const record = current(sessionId, expectedRevision, "activate");
      if (record.status !== "saved")
        throw new Error("Saved Draft is already activating or activated");
      const claimed = store({
        ...record,
        revision: record.revision + 1,
        status: "activating",
        workingDirectory: workingDirectory ?? record.workingDirectory,
      });
      const held = gate;
      gate = undefined;
      if (held) {
        held.claimed(claimed);
        await held.wait;
      }
      const activated = store({ ...claimed, revision: claimed.revision + 1, status: "activated" });
      return { record: activated, workingDirectory: activated.workingDirectory };
    },
  };

  return {
    client,
    records,
    snapshot: () => [...records.values()],
    holdActivation() {
      let release!: () => void;
      let claimed!: (record: SavedDraft) => void;
      const wait = new Promise<void>((resolve) => (release = resolve));
      const claimedPromise = new Promise<SavedDraft>((resolve) => (claimed = resolve));
      gate = { wait, claimed };
      return { claimed: claimedPromise, release };
    },
  };
}
