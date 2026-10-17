import { describe, expect, it } from "vitest";
import type { StoreSnapshot } from "r-state-tree";
import { migratePendingSessions } from "../../../../src/renderer/persistence/migrate-pending-sessions";
import { createRendererStoreFixture } from "../renderer-store-fixture";
import { fixtureTimestamp } from "../fixtures/catalog-fixtures";

function windowSnapshot(state: Record<string, unknown>): StoreSnapshot {
  return {
    state: {},
    children: {
      sessionRegistry: {
        state: { targets: [{ sessionId: "unsent", workspacePath: "/project" }] },
        children: {
          pendingSessions: {
            state,
            children: {
              conversations: [
                {
                  key: "unsent",
                  state: {
                    name: "My task",
                    labelIds: ["feature"],
                    configuration: {
                      provider: "openai",
                      modelId: "gpt-5",
                      thinkingLevel: "high",
                      fastMode: false,
                    },
                  },
                  children: {},
                },
                {
                  key: "started",
                  state: {
                    fallbackTitle: "Starting task",
                    messageCount: 1,
                    createdAt: fixtureTimestamp,
                    modifiedAt: fixtureTimestamp,
                  },
                  children: {},
                },
              ],
            },
          },
        },
      },
    },
  };
}

describe("Pending lifecycle snapshot migration", () => {
  it("migrates v0 membership into one phase without losing unsaved facts or family metadata", () => {
    const old = windowSnapshot({
      conversationIds: ["unsent", "started"],
      temporarySessionIds: ["unsent"],
      stagedSessionIds: ["unsent"],
      unlistedNewSessionIds: ["started"],
      summaryMetadataBySession: { unsent: { familyId: "family" } },
    });
    const before = structuredClone(old);
    const migrated = migratePendingSessions(old);
    using fixture = createRendererStoreFixture({ snapshot: migrated });
    const pending = fixture.root.sessionRegistry.pendingSessions;
    expect(pending.isStaged("unsent")).toBe(true);
    expect(pending.isTemporary("unsent")).toBe(true);
    expect(pending.isTemporary("started")).toBe(false);
    expect(pending.canCreateRuntime("started")).toBe(true);
    expect(pending.familyId("unsent")).toBe("family");
    expect(pending.conversation("unsent")).toMatchObject({
      name: "My task",
      labelIds: ["feature"],
      configuration: { modelId: "gpt-5" },
    });
    expect(old).toEqual(before);
  });

  it("restores an interrupted submission as staged for retry while preserving started phases", () => {
    const snapshot = windowSnapshot({
      lifecycleVersion: 1,
      sessionsById: {
        unsent: { phase: "submitting" },
        started: {
          phase: "unlisted",
          summary: {
            title: "Starting task",
            createdAt: fixtureTimestamp,
            modifiedAt: fixtureTimestamp,
            messageCount: 1,
            resolved: false,
          },
        },
      },
    });
    using fixture = createRendererStoreFixture({ snapshot });
    const pending = fixture.root.sessionRegistry.pendingSessions;
    expect(pending.isStaged("unsent")).toBe(true);
    expect(pending.isTemporary("unsent")).toBe(true);
    expect(pending.isStaged("started")).toBe(false);
    expect(pending.isTemporary("started")).toBe(false);
    expect(pending.canCreateRuntime("started")).toBe(true);
    expect(pending.conversation("unsent")?.name).toBe("My task");
  });
});
